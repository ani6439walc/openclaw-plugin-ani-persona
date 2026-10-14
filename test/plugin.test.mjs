import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import plugin from "../dist/index.js";

// Test the pinned host's real merge, cancellation and fail-open timeout semantics.
const hostDist = resolve(dirname(fileURLToPath(import.meta.resolve("openclaw/plugin-sdk/hook-runtime"))), "..");
const hookModule = await import(pathToFileURL(resolve(hostDist, readdirSync(hostDist).find(n => /^hooks-.*\.mjs$/.test(n)))));
const createHookRunner = Object.values(hookModule).find(fn => fn?.name === "createHookRunner");
assert.equal(typeof createHookRunner, "function");
const safeDiscord = () => ({ streaming: { mode: "off", block: { enabled: false } } });
const context = (patch = {}) => ({ sessionKey: "agent:main:discord:channel:123", runId: "run-1", channelId: "discord", accountId: "default", ...patch });
const event = (patch = {}) => ({ kind: "final", payload: { text: "ORIGINAL" }, ...patch });
function setup({ complete = async () => ({ text: "Ani final" }), config = { channels: { discord: safeDiscord() } }, timeout = 100, hostTimeout } = {}) {
  const typedHooks = [], calls = [], warnings = [];
  const api = {
    pluginConfig: { agentIds: ["main"], rewriteTimeoutMs: timeout }, config,
    runtime: { config: { current: () => config }, subagent: { complete(args) { calls.push(args); return complete(args); } } },
    logger: { warn: text => warnings.push(text) },
    on(hookName, handler, options) { typedHooks.push({ pluginId: "ani-persona", hookName, handler, ...options }); },
  };
  plugin.register(api);
  if (hostTimeout) typedHooks.find(h => h.hookName === "reply_payload_sending").timeoutMs = hostTimeout;
  const runner = createHookRunner({ typedHooks, plugins: [], hooks: [] });
  return { runner, calls, config, warnings, hooks: typedHooks };
}

test("real hook runner replaces final text, preserves attachments and uses bundled skill/context", async () => {
  const { runner, calls } = setup();
  await runner.runBeforePromptBuild({ prompt: "user request", currentUserMessage: "用繁體中文" }, { agentId: "main", runId: "run-1" });
  const payload = { text: "ORIGINAL", mediaUrl: "https://example.com/file.png", replyToId: "123" };
  const result = await runner.runReplyPayloadSending(event({ payload }), context());
  assert.deepEqual(result.payload, { ...payload, text: "Ani final" });
  assert.notEqual(result.cancel, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, "main");
  assert.equal(JSON.parse(calls[0].message).userContext, "用繁體中文");
  for (const file of ["SKILL.md", "assets/SOUL.md", "assets/IDENTITY.md", "references/"]) assert.ok(calls[0].extraSystemPrompt.includes(file));
  assert.equal(calls[0].tools, undefined);
  assert.notEqual((await runner.runMessageSending({ content: "Ani final" }, context()))?.cancel, true);
  assert.notEqual((await runner.runMessageSending({ content: "Ani final" }, context({ runId: undefined })))?.cancel, true);
  assert.equal((await runner.runMessageSending({ content: "ORIGINAL" }, context())).cancel, true);
  assert.equal((await runner.runMessageSending({ content: "Ani final" }, context({ runId: "different" }))).cancel, true);
  assert.equal((await runner.runMessageSending({ content: "Ani final" }, context({ accountId: "other" }))).cancel, true);
});

test("blocks intermediate text, tool sends and silent tokens without inference", async () => {
  const { runner, calls } = setup();
  for (const kind of ["block", "tool"]) assert.equal((await runner.runReplyPayloadSending(event({ kind }), context())).cancel, true);
  for (const text of ["NO_REPLY", " HEARTBEAT_OK "]) assert.equal((await runner.runReplyPayloadSending(event({ payload: { text } }), context())).cancel, true);
  assert.equal(calls.length, 0);
  assert.equal(await runner.runReplyPayloadSending(event({ payload: { mediaUrl: "https://example.com/a" } }), context()), undefined);
});

test("concurrent retries, replayed originals and rewritten reentry do not repeat inference", async () => {
  const { runner, calls } = setup({ complete: async () => { await delay(10); return { text: "Ani final" }; } });
  const [a, b] = await Promise.all([runner.runReplyPayloadSending(event(), context()), runner.runReplyPayloadSending(event(), context())]);
  assert.equal(a.payload.text, "Ani final"); assert.deepEqual(a, b);
  await runner.runReplyPayloadSending(event(), context());
  await runner.runReplyPayloadSending(event({ payload: { text: "Ani final" } }), context());
  assert.equal(calls.length, 1);
  await runner.runReplyPayloadSending(event(), context({ runId: "run-2" }));
  assert.equal(calls.length, 2);
});

test("own deadline aborts even an uncooperative completion and never approves late output", async () => {
  let finish;
  const { runner, calls } = setup({ complete: () => new Promise(resolve => { finish = resolve; }) });
  assert.equal((await runner.runReplyPayloadSending(event(), context())).cancel, true);
  assert.equal(calls[0].signal.aborted, true);
  finish({ text: "LATE" }); await delay(0);
  assert.equal((await runner.runMessageSending({ content: "LATE" }, context())).cancel, true);
  assert.equal((await runner.runReplyPayloadSending(event(), context())).cancel, true);
  assert.equal(calls.length, 1);
});

test("host fail-open timeout is caught by the independent synchronous payload gate", async () => {
  const { runner, calls } = setup({ hostTimeout: 5, complete: () => new Promise(() => {}) });
  const result = await runner.runReplyPayloadSending(event(), context());
  assert.equal(result.cancel, true);
  assert.equal(result.reason, "ani-persona:unapproved-text");
  assert.equal(calls[0].signal.aborted, true);
});

test("errors and unusable rewrites suppress originals", async () => {
  for (const complete of [async () => { throw Error("provider failed"); }, async () => ({ text: " " }), async () => ({ text: "NO_REPLY" })]) {
    const { runner } = setup({ complete });
    assert.equal((await runner.runReplyPayloadSending(event(), context())).cancel, true);
  }
});

test("only selected destinations are changed; targeted text without run identity is blocked", async () => {
  const { runner, calls } = setup();
  for (const ctx of [context({ sessionKey: "agent:other:discord:channel:123" }), context({ channelId: "telegram" })]) {
    assert.equal(await runner.runReplyPayloadSending(event(), ctx), undefined);
  }
  assert.equal((await runner.runReplyPayloadSending(event(), context({ runId: undefined }))).cancel, true);
  assert.equal(calls.length, 0);
});

test("Discord unsafe startup retains blocking hooks instead of unloading the plugin", async () => {
  for (const discord of [{}, { streaming: { mode: "partial", block: { enabled: false } } }, { streaming: { mode: "off" } }, { ...safeDiscord(), accounts: { Bot: { streaming: { mode: "off" } } } }]) {
    const registered = setup({ config: { channels: { discord } } });
    assert.equal(registered.warnings.length, 1);
    assert.equal((await registered.runner.runBeforeAgentRun({}, { agentId: "main", channel: "discord" })).decision.outcome, "block");
    assert.equal((await registered.runner.runReplyPayloadSending(event(), context({ accountId: undefined }))).cancel, true);
  }
  setup({ config: { channels: { discord: { ...safeDiscord(), accounts: { Bot: { streaming: { mode: "off", block: { enabled: false } } } } } } } });
});

test("current Discord configuration is rechecked before generation and delivery", async () => {
  const { runner, config, calls } = setup();
  config.channels.discord.streaming.mode = "partial";
  assert.equal((await runner.runBeforeAgentRun({}, { agentId: "main", channel: "discord" })).decision.outcome, "block");
  assert.equal((await runner.runReplyPayloadSending(event(), context())).cancel, true);
  assert.equal(calls.length, 0);
});

test("Gateway stop aborts pending inference and clears approvals", async () => {
  const { runner, calls } = setup({ complete: () => new Promise(() => {}) });
  const pending = runner.runReplyPayloadSending(event(), context());
  await delay(0);
  await runner.runGatewayStop({ reason: "test" }, {});
  assert.equal(calls[0].signal.aborted, true);
  assert.equal((await pending).cancel, true);
});

test("independent rich text and generated speech cannot bypass rewriting", async () => {
  const { runner, calls } = setup();
  for (const field of ["fallbackText", "presentation", "interactive", "channelData", "btw", "location", "spokenText", "ttsSupplement"]) {
    for (const text of [undefined, "ORIGINAL"]) {
      assert.equal((await runner.runReplyPayloadSending(event({ payload: { text, [field]: { text: "HIDDEN ORIGINAL" } } }), context())).cancel, true);
    }
  }
  assert.equal(calls.length, 0);
});
