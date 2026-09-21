import test from 'node:test';
import assert from 'node:assert/strict';
import { answer, extractMemory, readLastGeminiError, requestGeminiInteraction } from '../.test-dist/gemini.js';
import { UpstreamTimeoutError } from '../.test-dist/timeout.js';

const okInteraction=(text)=>new Response(JSON.stringify({
  status:'completed',
  steps:[{type:'model_output',content:[{type:'text',text}]}],
}),{status:200,headers:{'content-type':'application/json'}});

const quotaResponse=()=>new Response(JSON.stringify({
  error:{code:429,status:'RESOURCE_EXHAUSTED',message:'quota exceeded'},
}),{status:429,headers:{'content-type':'application/json'}});

function dbWithBlock(model,blockedUntil=Date.now()+60_000){
  return {
    prepare(){
      return {
        bind(){
          return {
            async all(){
              return {results:[{
                key:`gemini_quota:${model}`,
                value:JSON.stringify({blockedUntil,scope:'minute'}),
              }]};
            },
            async run(){return {success:true};},
          };
        },
      };
    },
  };
}

test('429 immediately falls through to the next model instead of retrying the exhausted model',async()=>{
  const originalFetch=globalThis.fetch;
  const calls=[];
  globalThis.fetch=async(_url,init)=>{
    const body=JSON.parse(init.body);
    calls.push(body.model);
    return calls.length===1 ? quotaResponse() : okInteraction('fallback answer');
  };
  try{
    const env={
      GEMINI_API_KEY:'test',
      GEMINI_MODEL:'gemini-flash-latest',
      GEMINI_FALLBACK_MODELS:'gemini-3.7-flash,gemini-3.6-flash',
    };
    const result=await answer(env,'system','prompt',[],'medium');
    assert.deepEqual(calls,['gemini-flash-latest','gemini-3.7-flash']);
    assert.equal(result.text,'fallback answer');
    assert.equal(result.model,'gemini-3.7-flash');
    assert.deepEqual(result.exhaustedModels,['gemini-flash-latest']);
    assert.deepEqual(result.newlyExhaustedModels,['gemini-flash-latest']);
    assert.deepEqual(result.routeFailures,[{model:'gemini-flash-latest',reason:'quota'}]);
    assert.equal(result.allModelsExhausted,false);
  }finally{
    globalThis.fetch=originalFetch;
  }
});

test('a persisted quota block skips the known-exhausted model without another API request',async()=>{
  const originalFetch=globalThis.fetch;
  const calls=[];
  globalThis.fetch=async(_url,init)=>{
    const body=JSON.parse(init.body);
    calls.push(body.model);
    return okInteraction('lower model answer');
  };
  try{
    const env={
      DB:dbWithBlock('gemini-flash-latest'),
      GEMINI_API_KEY:'test',
      GEMINI_MODEL:'gemini-flash-latest',
      GEMINI_FALLBACK_MODELS:'gemini-3.7-flash,gemini-3.6-flash',
    };
    const result=await answer(env,'system','prompt',[],'medium');
    assert.deepEqual(calls,['gemini-3.7-flash']);
    assert.equal(result.model,'gemini-3.7-flash');
    assert.deepEqual(result.exhaustedModels,['gemini-flash-latest']);
    assert.deepEqual(result.newlyExhaustedModels,[]);
    assert.deepEqual(result.routeFailures,[{model:'gemini-flash-latest',reason:'quota'}]);
  }finally{
    globalThis.fetch=originalFetch;
  }
});

test('524 from the latest model falls through instead of returning after the origin timeout',async()=>{
  const originalFetch=globalThis.fetch;
  const calls=[];
  globalThis.fetch=async(_url,init)=>{
    const body=JSON.parse(init.body);
    calls.push(body.model);
    if(calls.length===1) return new Response('timeout',{status:524});
    return okInteraction('lower model after timeout');
  };
  try{
    const env={
      GEMINI_API_KEY:'test',
      GEMINI_MODEL:'gemini-flash-latest',
      GEMINI_FALLBACK_MODELS:'gemini-3.7-flash',
      GEMINI_MODEL_TIMEOUT_MS:'45000',
      GEMINI_REPLY_DEADLINE_MS:'90000',
    };
    const result=await answer(env,'system','prompt',[],'medium');
    assert.deepEqual(calls,['gemini-flash-latest','gemini-3.7-flash']);
    assert.equal(result.model,'gemini-3.7-flash');
    assert.equal(result.text,'lower model after timeout');
    assert.deepEqual(result.routeFailures,[{model:'gemini-flash-latest',reason:'timeout'}]);
  }finally{
    globalThis.fetch=originalFetch;
  }
});

test('all configured conversation models can be exhausted without same-model retry amplification',async()=>{
  const originalFetch=globalThis.fetch;
  const calls=[];
  globalThis.fetch=async(_url,init)=>{
    const body=JSON.parse(init.body);
    calls.push(body.model);
    return quotaResponse();
  };
  try{
    const env={
      GEMINI_API_KEY:'test',
      GEMINI_MODEL:'gemini-flash-latest',
      GEMINI_FALLBACK_MODELS:'gemini-3.7-flash,gemini-3.6-flash',
    };
    const result=await answer(env,'system','prompt',[],'medium');
    assert.deepEqual(calls,['gemini-flash-latest','gemini-3.7-flash','gemini-3.6-flash']);
    assert.equal(result.model,null);
    assert.equal(result.allModelsExhausted,true);
    assert.deepEqual(result.exhaustedModels,calls);
    assert.deepEqual(result.newlyExhaustedModels,calls);
  }finally{
    globalThis.fetch=originalFetch;
  }
});

const baseEnv={GEMINI_API_KEY:'test-secret',GEMINI_MODEL:'gemini-flash-latest',GEMINI_FALLBACK_MODELS:'gemini-3.7-flash'};
const apiFailure=(status,message,code='INVALID_ARGUMENT')=>new Response(JSON.stringify({error:{status:code,message}}),{status});

test('only an explicit unsupported thinking parameter receives one compatibility retry',async(t)=>{
  const calls=[];
  t.mock.method(globalThis,'fetch',async(_url,init)=>{
    calls.push(JSON.parse(init.body));
    return calls.length===1 ? apiFailure(400,'thinking_level medium is not supported for this model') : okInteraction('recovered');
  });
  const result=await answer(baseEnv,'system','prompt',[],'medium');
  assert.equal(result.text,'recovered');
  assert.equal(result.model,'gemini-flash-latest');
  assert.equal(calls.length,2);
  assert.deepEqual(calls[0].generation_config,{thinking_level:'medium'});
  assert.deepEqual(calls[1].generation_config,{});
  assert.equal(calls[1].system_instruction,'system');
  assert.equal(calls[1].store,false);
});

test('thinking compatibility retry is bounded and preserves other generation settings',async(t)=>{
  const calls=[];
  t.mock.method(globalThis,'fetch',async(_url,init)=>{
    calls.push(JSON.parse(init.body));
    return apiFailure(400,'Unknown field thinking_level');
  });
  await assert.rejects(requestGeminiInteraction(baseEnv,'gemini-flash-latest',{
    input:'hello',generation_config:{thinking_level:'high',max_output_tokens:500},
  },1000,1),(error)=>error.category==='thinking_unsupported');
  assert.equal(calls.length,2);
  assert.deepEqual(calls[1].generation_config,{max_output_tokens:500});
});

test('unavailable model falls through while an unrelated bad request does not',async(t)=>{
  const calls=[];
  t.mock.method(globalThis,'fetch',async(_url,init)=>{
    calls.push(JSON.parse(init.body).model);
    return calls.length===1 ? apiFailure(404,'Model gemini-flash-latest is not available','NOT_FOUND') : okInteraction('fallback');
  });
  const result=await answer(baseEnv,'system','prompt',[],'medium');
  assert.deepEqual(calls,['gemini-flash-latest','gemini-3.7-flash']);
  assert.equal(result.text,'fallback');
  assert.equal(result.allModelsExhausted,false);
  assert.deepEqual(result.exhaustedModels,[]);
});

test('generic 400 is diagnosed once without quota writes or futile retries',async(t)=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return apiFailure(400,'Invalid input format');});
  const result=await answer(baseEnv,'system','prompt',[],'medium');
  assert.equal(calls,1);
  assert.equal(result.model,null);
  assert.match(result.text,/HTTP 400 \/ invalid_request/);
  assert.equal(result.allModelsExhausted,false);
  assert.deepEqual(result.exhaustedModels,[]);
});

test('invalid API key is actionable and secrets are absent from logs, diagnostics and LINE output',async(t)=>{
  const logs=[];
  const writes=[];
  let calls=0;
  const privateContent='private-family-message-123';
  t.mock.method(console,'warn',(...args)=>logs.push(args));
  t.mock.method(globalThis,'fetch',async()=>{
    calls++;
    return apiFailure(400,`API key not valid. test-secret ${privateContent}`);
  });
  const DB={prepare(sql){return {bind(...args){return {
    async all(){return {results:[]};},
    async run(){writes.push({sql,args});return {success:true};},
    async first(){return writes.length ? {value:writes.at(-1).args[1]} : null;},
  };}};}};
  const env={...baseEnv,DB};
  const result=await answer(env,'system',privateContent,[],'medium');
  assert.equal(calls,1);
  assert.match(result.text,/APIキー/);
  assert.match(result.text,/authentication/);
  const diagnostic=await readLastGeminiError(env);
  assert.equal(diagnostic.category,'authentication');
  assert.deepEqual(Object.keys(diagnostic).sort(),['category','model','status','time']);
  assert.equal(writes.length,1);
  const persisted=JSON.stringify({logs,writes,text:result.text});
  assert.ok(!persisted.includes('test-secret'));
  assert.ok(!persisted.includes(privateContent));
});

test('leaked API keys stop immediately without trying every model',async(t)=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{
    calls++;
    return apiFailure(403,'Your API key was reported as leaked. Please use another API key.','PERMISSION_DENIED');
  });
  const result=await answer(baseEnv,'system','prompt',[],'medium');
  assert.equal(calls,1);
  assert.match(result.text,/authentication/);
  assert.equal(result.model,null);
});

test('billing failures do not silently activate billing or bypass into a fallback',async(t)=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return apiFailure(400,'Please enable billing to use this feature','FAILED_PRECONDITION');});
  const result=await answer(baseEnv,'system','prompt',[],'medium');
  assert.equal(calls,1);
  assert.match(result.text,/billing/);
  assert.equal(result.terminalReason,'upstream');
});

test('failed or incomplete HTTP 200 interactions never become a successful partial answer',async(t)=>{
  const calls=[];
  t.mock.method(globalThis,'fetch',async(_url,init)=>{
    calls.push(JSON.parse(init.body).model);
    if(calls.length===1) return new Response(JSON.stringify({status:'incomplete',steps:[{type:'model_output',content:[{type:'text',text:'unfinished'}]}]}),{status:200});
    return okInteraction('complete answer');
  });
  const result=await answer(baseEnv,'system','prompt',[],'medium');
  assert.equal(result.text,'complete answer');
  assert.equal(result.model,'gemini-3.7-flash');
  assert.equal(calls.length,2);
});

test('content blocks are not bypassed by switching models',async(t)=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{
    calls++;
    return new Response(JSON.stringify({status:'failed',errors:[{code:'CONTENT_BLOCKED',message:'Blocked by safety filter'}],steps:[]}),{status:200});
  });
  const result=await answer(baseEnv,'system','prompt',[],'medium');
  assert.equal(calls,1);
  assert.equal(result.model,null);
  assert.match(result.text,/内容/);
});

test('network failure falls through without leaking transport error messages',async(t)=>{
  let calls=0;
  const logs=[];
  t.mock.method(console,'warn',(...args)=>logs.push(args));
  t.mock.method(globalThis,'fetch',async()=>{
    if(++calls===1) throw new Error('Network failed with test-secret');
    return okInteraction('recovered');
  });
  const result=await answer(baseEnv,'system','prompt',[],'medium');
  assert.equal(result.text,'recovered');
  assert.equal(calls,2);
  assert.ok(!JSON.stringify(logs).includes('test-secret'));
});

test('response body reading remains inside the request deadline',async(t)=>{
  t.mock.method(globalThis,'fetch',async()=>({ok:true,status:200,text:()=>new Promise(()=>{})}));
  const started=Date.now();
  await assert.rejects(requestGeminiInteraction(baseEnv,'gemini-flash-latest',{input:'hello'},20,1),
    (error)=>error instanceof UpstreamTimeoutError);
  assert.ok(Date.now()-started<500);
});

test('retry delay cannot exceed the per-model deadline',async(t)=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return apiFailure(503,'Unavailable','UNAVAILABLE');});
  const started=Date.now();
  await assert.rejects(requestGeminiInteraction(baseEnv,'gemini-flash-latest',{input:'hello'},20,2),
    (error)=>error instanceof UpstreamTimeoutError);
  assert.equal(calls,1);
  assert.ok(Date.now()-started<500);
});

test('memory authentication failure is postponed instead of endlessly retrying a queue item',async(t)=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return apiFailure(400,'API key not valid');});
  const result=await extractMemory({...baseEnv,GEMINI_MEMORY_MODEL:'gemini-3.5-flash-lite'},'memory prompt');
  assert.equal(result,null);
  assert.equal(calls,1);
});
