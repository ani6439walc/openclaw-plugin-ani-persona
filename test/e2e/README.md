# Isolated delivery proof

Requires Node 26+, OpenClaw **2026.10.3** on PATH, and this plugin built with
`npm run build`. No real model credentials, Discord token, or Discord server is
used. The script creates a temporary state/config/workspace and a separate
loopback Gateway; it never starts or changes the normal Gateway.

## Official Discord outbound adapter

Fetch the matching official adapter into a temporary directory, then provide its
extracted package path:

```sh
ani_discord_dir=$(mktemp -d)
npm pack @openclaw/discord@2026.10.3 --pack-destination "$ani_discord_dir"
tar -xzf "$ani_discord_dir/openclaw-discord-2026.10.3.tgz" -C "$ani_discord_dir"
mkdir -p "$ani_discord_dir/package/node_modules"
ln -s "$(npm root -g)/openclaw" "$ani_discord_dir/package/node_modules/openclaw"
ANI_TEST_DISCORD_PACKAGE="$ani_discord_dir/package" node test/e2e/gateway.mjs
```

The symlink resolves the adapter's OpenClaw SDK peer dependency. If your
OpenClaw installation is not under `npm root -g`, use its actual package path.
The downloaded adapter remains outside the repository and is not installed into
normal OpenClaw state.

The test runs this path:

1. Authenticated test HTTP ingress invokes OpenClaw's real
   `dispatchReplyWithBufferedBlockDispatcher`.
2. The main agent receives a mock OpenAI SSE completion containing an identifiable
   original draft.
3. The loaded Ani plugin calls the real `runtime.subagent.complete`, which receives
   a separate mock completion with no tools.
4. The official Discord `sendMessageDiscord` adapter sends through its supported
   `DISCORD_API_URL` loopback override to a recording Discord REST server.

Assertions cover:

- Provider streaming is active, but no original draft reaches the transport.
- A successful turn performs exactly one tool-free rewrite and delivers exactly
  one rewritten message.
- A first Discord send returns HTTP 429. Both transport attempts contain only
  the rewrite, and the retry does not perform another rewrite.
- A delayed rewrite exceeds the plugin deadline; neither the original draft nor
  OpenClaw's resulting delivery fallback reaches Discord REST.

The script prints the temporary evidence directory. `evidence.json` contains
mock model requests, Discord POST attempts, successful deliveries, and Gateway
logs. Child Gateway and mock servers are stopped on exit.

This verifies the real core reply lifecycle, plugin runtime, and official
Discord outbound adapter. It does **not** establish a Discord WebSocket login,
exercise Discord's inbound event adapter or native preview implementation, or
validate persona quality with a real model. Discord preview and block delivery
are explicitly disabled in the isolated configuration.

## Core lifecycle without the Discord package

```sh
node test/e2e/gateway.mjs
```

This uses the same real Gateway/model/runtime flow with a minimal recording HTTP
transport. Discord REST retry assertions apply only to the adapter mode above.
