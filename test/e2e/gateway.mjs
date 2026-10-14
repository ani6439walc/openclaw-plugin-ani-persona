import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, mkdir, writeFile, copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const root = resolve(import.meta.dirname, '../..');
const temp = await mkdtemp(join(tmpdir(), 'ani-gateway-test-'));
const deliveries = [], requests = [], discordAttempts = [];
const discordPackage = process.env.ANI_TEST_DISCORD_PACKAGE;
let mode = 'success';
const mock = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  if (req.url.startsWith('/discord/')) {
    res.setHeader('content-type','application/json');
    if(req.method==='POST' && req.url.endsWith('/messages')) {
      discordAttempts.push({scenario:mode,path:req.url,body});
      if(discordAttempts.length===1) {res.writeHead(429,{'retry-after':'0.01'}).end(JSON.stringify({retry_after:0.01,global:false}));return;}
      deliveries.push({id:mode,payload:{text:body.content}});res.end(JSON.stringify({id:'987654321012345678',channel_id:'123456789012345678',content:body.content}));}
    else res.end(JSON.stringify({id:'123456789012345678',type:0}));
    return;
  }
  if (req.url === '/delivery') { deliveries.push(body); res.end('{}'); return; }
  requests.push(body);
  body.testScenario = mode;
  const rewrite = !body.tools?.length;
  const text = rewrite ? 'Baby，任務已完成，這是 Ani 改寫後的答覆。' : 'ORIGINAL_DRAFT_MUST_NOT_LEAK';
  if (rewrite && mode === 'timeout') await delay(7000);
  if (body.stream) {
    res.writeHead(200, {'content-type':'text/event-stream'});
    for (const content of [text.slice(0, 12), text.slice(12)]) {
      res.write(`data: ${JSON.stringify({id:'mock',object:'chat.completion.chunk',model:'mock',choices:[{index:0,delta:{role:'assistant',content},finish_reason:null}]})}\n\n`);
      await delay(50);
    }
    res.end(`data: ${JSON.stringify({id:'mock',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})}\n\ndata: [DONE]\n\n`);
  } else {
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:'mock',object:'chat.completion',model:'mock',choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}));
  }
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const serverUrl = `http://127.0.0.1:${mock.address().port}`;
const reserve = createServer(); await new Promise(r => reserve.listen(0,'127.0.0.1',r));
const port = reserve.address().port; await new Promise(r => reserve.close(r));
const probe = join(temp,'probe'); await mkdir(probe); await mkdir(join(temp,'workspace'));
await copyFile(join(import.meta.dirname,'delivery-probe.mjs'),join(probe,'index.mjs'));
await writeFile(join(probe,'package.json'),JSON.stringify({name:'ani-delivery-probe',type:'module',openclaw:{extensions:['./index.mjs']}}));
await writeFile(join(probe,'openclaw.plugin.json'),JSON.stringify({id:'ani-delivery-probe',activation:{onStartup:true},configSchema:{type:'object',additionalProperties:false,properties:{}}}));
const config = {
 ...(process.env.ANI_TEST_DISCORD_PACKAGE ? {channels:{discord:{enabled:false,streaming:{mode:'off',block:{enabled:false}}}}} : {}),
 gateway:{mode:'local',bind:'loopback',port,auth:{mode:'token',token:'ani-isolated-test-token'},controlUi:{enabled:false}},
 agents:{defaults:{workspace:join(temp,'workspace'),skipBootstrap:true,model:{primary:'mock/mock'},blockStreamingDefault:'off'},entries:{main:{}}},
 models:{mode:'replace',providers:{mock:{baseUrl:`${serverUrl}/v1`,apiKey:'local-mock-only',api:'openai-completions',models:[{id:'mock',name:'Mock',contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}},
 plugins:{allow:['ani-persona','ani-delivery-probe'],load:{paths:[root,probe]},entries:{'ani-persona':{enabled:true,hooks:{allowConversationAccess:true},config:{agentIds:['main'],channels:[process.env.ANI_TEST_DISCORD_PACKAGE ? 'discord' : 'ani-test'],rewriteTimeoutMs:5000}},'ani-delivery-probe':{enabled:true}}},
};
await writeFile(join(temp,'openclaw.json'),JSON.stringify(config));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/API_KEY|TOKEN|SECRET|PASSWORD|OPENCLAW|ANTHROPIC|OPENAI/.test(k)));
Object.assign(env,{OPENCLAW_STATE_DIR:temp,OPENCLAW_CONFIG_PATH:join(temp,'openclaw.json'),ANI_TEST_TOKEN:'ani-isolated-test-token',ANI_TEST_SERVER:serverUrl,...(process.env.ANI_TEST_DISCORD_PACKAGE ? {ANI_TEST_DISCORD_PACKAGE:process.env.ANI_TEST_DISCORD_PACKAGE,DISCORD_API_URL:`${serverUrl}/discord`} : {})});
const child = spawn('openclaw',['gateway','run','--port',String(port)],{env,stdio:['ignore','pipe','pipe']});
let logs=''; child.stdout.on('data',c=>logs+=c); child.stderr.on('data',c=>logs+=c);
console.log(`Isolated evidence directory: ${temp}`);
try {
  let ready=false;
  for(let i=0;i<120;i++) {
    if(child.exitCode!==null) throw Error(`Gateway exited ${child.exitCode}\n${logs}`);
    try { const r=await fetch(`http://127.0.0.1:${port}/health`); if(r.ok){ready=true;break;} } catch {}
    await delay(250);
  }
  assert(ready, `Gateway not ready\n${logs}`);
  for(const scenario of ['success','timeout']) {
    mode=scenario;
    const response=await fetch(`http://127.0.0.1:${port}/ani-test`,{method:'POST',headers:{authorization:'Bearer ani-isolated-test-token','content-type':'application/json'},body:JSON.stringify({id:scenario,message:`Please complete this simple task: say task completed. Case ${scenario}.`}),signal:AbortSignal.timeout(90000)});
    const result=await response.text(); console.log(scenario,response.status,result); assert(response.ok,result);
    const sent=deliveries.filter(x=>x.id===scenario);
    if(scenario==='success') {assert.equal(sent.length,1);assert.equal(sent[0].payload.text,'Baby，任務已完成，這是 Ani 改寫後的答覆。');}
    else assert.equal(sent.length,0);
  }
  assert(!JSON.stringify(deliveries).includes('ORIGINAL_DRAFT_MUST_NOT_LEAK'));
  assert(requests.some(r=>r.stream));
  assert(requests.some(r=>!r.tools?.length));
  assert.equal(requests.filter(r=>r.testScenario==='success' && !r.tools?.length).length,1, 'one internal rewrite despite transport retry');
  if(discordPackage) {assert.equal(discordAttempts.length,2); assert(discordAttempts.every(a=>a.body.content==='Baby，任務已完成，這是 Ani 改寫後的答覆。'));}
  console.log('PASS: actual HTTP transport received only rewritten final; timeout delivered nothing.');
} finally {
  child.kill('SIGTERM');
  await Promise.race([new Promise(r=>child.once('exit',r)),delay(5000)]);
  if(child.exitCode===null) child.kill('SIGKILL');
  mock.closeAllConnections(); await new Promise(r=>mock.close(r));
  await writeFile(join(temp,'evidence.json'),JSON.stringify({discordPackage,deliveries,discordAttempts,requests,logs},null,2));
}
