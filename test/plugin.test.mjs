import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { runAgentHarnessBeforeAgentFinalizeHook } from "openclaw/plugin-sdk/agent-harness-runtime";
import plugin from "../dist/index.js";

function register(agentIds = ["main"]) {
  let handler;
  plugin.register({
    pluginConfig: { agentIds },
    on(name, fn) {
      assert.equal(name, "before_agent_finalize");
      handler = fn;
    },
  });
  return handler;
}

test("the real host grants one revision per run and retains the exact draft", async () => {
  const handler = register();
  const draft = '完成 3 個測試。\n```sh\nprintf "<draft>"\n```\nhttps://example.com/a?b=1';
  const ctx = { runId: randomUUID(), agentId: "main", trigger: "user" };
  const event = { sessionId: randomUUID(), lastAssistantMessage: draft, stopHookActive: false };
  const hookRunner = { hasHooks: () => true, runBeforeAgentFinalize: handler };
  const invoke = () => runAgentHarnessBeforeAgentFinalizeHook({ event, ctx, hookRunner });
  const first = await invoke();
  assert.equal(first.action, "revise");
  assert.ok(first.reason.includes(JSON.stringify(draft)));
  assert.ok(first.reason.includes('"file":"SKILL.md"'));
  assert.ok(first.reason.includes('"file":"assets/SOUL.md"'));
  assert.equal((await invoke()).action, "continue");
  ctx.runId = randomUUID();
  assert.equal((await invoke()).action, "revise");
});

test("only configured human-facing runs with a real draft are eligible", () => {
  const handler = register();
  const event = { runId: randomUUID(), sessionId: "s", lastAssistantMessage: "done", stopHookActive: false };
  const ctx = { agentId: "main", trigger: "user" };
  for (const patch of [
    { agentId: "other" }, { agentId: undefined }, { trigger: "cron" },
    { trigger: "heartbeat" }, { trigger: undefined },
    { sessionKey: "agent:main:subagent:worker" },
    { inputProvenance: { kind: "inter_session" } },
    { inputProvenance: { kind: "internal_system" } },
  ]) assert.equal(handler(event, { ...ctx, ...patch }), undefined);
  for (const patch of [
    { runId: undefined }, { stopHookActive: true },
    { lastAssistantMessage: "" }, { lastAssistantMessage: "  " },
    { lastAssistantMessage: "NO_REPLY" }, { lastAssistantMessage: " HEARTBEAT_OK\n" },
  ]) assert.equal(handler({ ...event, ...patch }, ctx), undefined);
  assert.equal(handler(event, ctx).action, "revise");
  assert.throws(() => register([]), /agentIds/);
});
