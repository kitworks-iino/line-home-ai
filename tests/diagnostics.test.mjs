import test from 'node:test';
import assert from 'node:assert/strict';
import { RELEASE, releaseCheck, runReleaseCheck } from '../.test-dist/diagnostics.js';

function environment() {
  const values=new Map(), sent=[];
  return {GEMINI_API_KEY:'test-secret',GEMINI_MODEL:'gemini-flash-latest',
    sent, values, MEMORY_QUEUE:{async send(job){sent.push(job);}},
    DB:{prepare(sql){let args=[];return {
      bind(...x){args=x;return this;},
      async first(){
        if(sql.startsWith('SELECT'))return values.has(args[0])?{value:values.get(args[0])}:null;
        if(sql.startsWith('INSERT')){if(values.has(args[0]))return null;values.set(args[0],args[1]);return {key:args[0]};}
        if(sql.startsWith('UPDATE')){if(values.get(args[2])!==args[3])return null;values.set(args[2],args[0]);return {key:args[2]};}
      },
      async run(){if(sql.startsWith('INSERT'))values.set(args[0],args[1]);else if(sql.startsWith('UPDATE'))values.set(args[2],args[0]);return {success:true};},
    };}},
  };
}

test('health probes are fixed and once per release even with repeated health requests or queue deliveries',async(t)=>{
  const env=environment();
  await releaseCheck(env);await releaseCheck(env);
  assert.deepEqual(env.sent,[{kind:'diagnostic',release:RELEASE}]);
  let calls=0;
  t.mock.method(globalThis,'fetch',async(url)=>{
    calls++;
    assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/interactions');
    return new Response(JSON.stringify({error:{message:'API key not valid. test-secret'}}),{status:400});
  });
  await runReleaseCheck(env,RELEASE);await runReleaseCheck(env,RELEASE);await runReleaseCheck(env,'arbitrary');
  assert.equal(calls,1);
  const result=await releaseCheck(env);
  assert.equal(result.state,'failed');assert.equal(result.category,'authentication');assert.equal(result.status,400);
  assert.ok(!JSON.stringify(result).includes('test-secret'));
});

test('failed queue enqueue releases only the queued reservation so a later health request can enqueue',async()=>{
  const env=environment();
  const original=env.DB.prepare;
  env.DB.prepare=function(sql){
    if(sql.startsWith('DELETE')) return {
      bind(key,value){return {async run(){if(env.values.get(key)===value)env.values.delete(key);}};},
    };
    return original(sql);
  };
  env.MEMORY_QUEUE.send=async()=>{throw new Error('queue unavailable');};
  assert.equal((await releaseCheck(env)).state,'queue_unavailable');
  assert.equal(env.values.size,0);
});
