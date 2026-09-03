import test from 'node:test';
import assert from 'node:assert/strict';
import { answer } from '../.test-dist/gemini.js';
import { pushText, replyText } from '../.test-dist/line.js';

test('Gemini current Interactions request contract',async(t)=>{
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    calls.push([url,init]);
    return new Response(JSON.stringify({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:'ok'}]}]}),{status:200});
  });
  const env={GEMINI_API_KEY:'g',GEMINI_MODEL:'gemini-flash-latest',GEMINI_FALLBACK_MODELS:''};
  const result=await answer(env,'system','prompt',[],'high');
  assert.equal(result.text,'ok');
  assert.equal(result.model,'gemini-flash-latest');
  assert.deepEqual(result.exhaustedModels,[]);
  const [url,init]=calls[0];
  assert.equal(String(url),'https://generativelanguage.googleapis.com/v1beta/interactions');
  const body=JSON.parse(String(init.body));
  assert.equal(body.model,'gemini-flash-latest');
  assert.equal(body.store,false);
  assert.equal(body.system_instruction,'system');
  assert.deepEqual(body.generation_config,{thinking_level:'high'});
  assert.deepEqual(body.input[0],{type:'text',text:'prompt'});
});

test('LINE stateless token then reply contract',async(t)=>{
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    calls.push([url,init]);
    if(calls.length===1) return new Response(JSON.stringify({access_token:'tok',expires_in:900}),{status:200});
    if(String(url).endsWith('/reply')) return new Response(JSON.stringify({sentMessages:[{id:'1'}]}),{status:200});
    return new Response(JSON.stringify({message:'retry key already accepted'}),{status:409});
  });
  const env={LINE_CHANNEL_ID:'id',LINE_CHANNEL_SECRET:'secret'};
  const r=await replyText(env,'reply-token','hello');
  assert.equal(r.ok,true);
  assert.equal(String(calls[0][0]),'https://api.line.me/oauth2/v3/token');
  assert.equal(calls[0][1].body.get('grant_type'),'client_credentials');
  assert.equal(calls[0][1].body.get('client_id'),'id');
  assert.equal(String(calls[1][0]),'https://api.line.me/v2/bot/message/reply');
  const reply=JSON.parse(String(calls[1][1].body));
  assert.equal(reply.replyToken,'reply-token');
  assert.equal(reply.messages[0].text,'hello');

  const retryKey='550e8400-e29b-41d4-a716-446655440000';
  const pushed=await pushText(env,'C123','fallback',retryKey);
  assert.equal(pushed.ok,true);
  assert.equal(pushed.status,409);
  assert.equal(String(calls[2][0]),'https://api.line.me/v2/bot/message/push');
  assert.equal(new Headers(calls[2][1].headers).get('x-line-retry-key'),retryKey);
  const push=JSON.parse(String(calls[2][1].body));
  assert.equal(push.to,'C123');
  assert.equal(push.messages[0].text,'fallback');
});
