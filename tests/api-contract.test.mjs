import test from 'node:test';
import assert from 'node:assert/strict';
import { answer, extractMemory, mediaInputs } from '../.test-dist/gemini.js';
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

test('memory extraction uses the current structured output request contract',async(t)=>{
  let request;
  t.mock.method(globalThis,'fetch',async(_url,init)=>{
    request=JSON.parse(init.body);
    return new Response(JSON.stringify({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:'{"summary":"家族の予定","memories":[]}'}]}]}),{status:200});
  });
  const result=await extractMemory({GEMINI_API_KEY:'g',GEMINI_MEMORY_MODEL:'gemini-3.5-flash-lite'},'context');
  assert.deepEqual(result,{summary:'家族の予定',memories:[]});
  assert.equal(request.model,'gemini-3.5-flash-lite');
  assert.equal(request.response_format.type,'text');
  assert.equal(request.response_format.mime_type,'application/json');
  assert.deepEqual(request.response_format.schema.required,['summary','memories']);
  assert.equal(request.store,false);
});

const attachment=(id,mime)=>({line_message_id:id,media_key:id,mime_type:mime,sender_name:'家族',type:mime.split('/')[0],unsent:0});
const mediaEnv={MEDIA:{async get(){return {async arrayBuffer(){return new Uint8Array([1,2,3]).buffer;}};}}};

test('zero media context excludes all previous attachments without reading storage',async()=>{
  const env={MEDIA:{async get(){throw new Error('storage must not be read');}}};
  const result=await mediaInputs(env,[attachment('a','image/png')],0);
  assert.deepEqual(result.inputs,[]);
  await result.cleanup();
});

test('supported MIME aliases and parameters are normalized before reaching Gemini',async()=>{
  const messages=[attachment('a','Image/JPG; charset=binary'),attachment('b','audio/x-m4a'),attachment('c','video/quicktime')];
  const result=await mediaInputs(mediaEnv,messages,3);
  const binary=result.inputs.filter((input)=>input.type!=='text');
  assert.deepEqual(binary.map((input)=>[input.type,input.mime_type]),[['image','image/jpeg'],['audio','audio/m4a'],['video','video/mov']]);
  assert.equal(binary.length,3);
});

test('an unsupported historical attachment cannot poison every later text request with an invalid MIME',async(t)=>{
  const result=await mediaInputs(mediaEnv,[attachment('svg','image/svg+xml'),attachment('audio','audio/mp4')],4);
  assert.ok(result.inputs.every((input)=>input.type==='text'));
  assert.match(result.inputs.map((input)=>input.text).join(' '),/対応外/);
  let request;
  t.mock.method(globalThis,'fetch',async(_url,init)=>{
    request=JSON.parse(init.body);
    return new Response(JSON.stringify({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:'テキスト回答'}]}]}),{status:200});
  });
  const answerResult=await answer({GEMINI_API_KEY:'g',GEMINI_MODEL:'gemini-flash-latest',GEMINI_FALLBACK_MODELS:''},'system','こんにちは',result.inputs,'medium');
  assert.equal(answerResult.text,'テキスト回答');
  assert.ok(request.input.every((input)=>input.type==='text'));
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
