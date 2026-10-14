// Test-only ingress and HTTP delivery adapter, loaded exclusively by gateway.mjs.
export default {
  id: 'ani-delivery-probe',
  register(api) {
    api.on('message_sending', (event, ctx) => { api.logger.info(`ani-test message-context=${JSON.stringify(ctx)}`); }, {priority:10000});
    api.on('reply_payload_sending', (event) => {
      api.logger.info(`ani-test hook kind=${event.kind} run=${event.runId} session=${event.sessionKey}`);
    }, {priority: 10000});
    api.registerHttpRoute({
      path: '/ani-test', auth: 'gateway',
      async handler(req, res) {
        if (req.headers.authorization !== `Bearer ${process.env.ANI_TEST_TOKEN}`) {
          res.writeHead(403).end(); return true;
        }
        try {
          const chunks = []; for await (const chunk of req) chunks.push(chunk);
          const input = JSON.parse(Buffer.concat(chunks).toString());
          const sessionKey = `agent:main:ani-test:${input.id}`;
          const reply = api.runtime.channel.reply;
          const ctx = reply.finalizeInboundContext({
            Body: input.message, BodyForAgent: input.message, RawBody: input.message,
            From: 'test-user', To: 'test-bot', SenderId: 'test-user',
            SessionKey: sessionKey, AccountId: 'default',
            Provider: process.env.ANI_TEST_DISCORD_PACKAGE ? 'discord' : 'ani-test', Surface: process.env.ANI_TEST_DISCORD_PACKAGE ? 'discord' : 'ani-test', OriginatingChannel: process.env.ANI_TEST_DISCORD_PACKAGE ? 'discord' : 'ani-test',
            OriginatingTo: 'test-user', ChatType: 'direct', CommandAuthorized: true,
            MessageSid: input.id,
          });
          const errors = [];
          const dispatcherOptions = {
            deliver: async (payload, info) => {
              if (process.env.ANI_TEST_DISCORD_PACKAGE) {
                const {sendMessageDiscord} = await import(`${process.env.ANI_TEST_DISCORD_PACKAGE}/dist/runtime-api.js`);
                return await sendMessageDiscord('channel:123456789012345678', payload.text, {cfg:{...api.config,channels:{discord:{token:'local-mock-only'}}},token:'local-mock-only'});
              }
              const response = await fetch(`${process.env.ANI_TEST_SERVER}/delivery`, {
                method: 'POST', headers: {'content-type': 'application/json'},
                body: JSON.stringify({id: input.id, payload, info}),
              });
              if (!response.ok) throw Error(`transport ${response.status}`);
            },
            onError: (error) => errors.push(String(error)),
          };
          const result = await reply.dispatchReplyWithBufferedBlockDispatcher({ctx, cfg: api.config, dispatcherOptions});
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({result, errors}));
        } catch (error) {res.writeHead(500).end(String(error.stack ?? error));}
        return true;
      },
    });
  },
};
