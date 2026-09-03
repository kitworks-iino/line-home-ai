import test from 'node:test';
import assert from 'node:assert/strict';
import { answer } from '../.test-dist/gemini.js';

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
