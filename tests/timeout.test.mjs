import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithTimeout, UpstreamTimeoutError } from '../.test-dist/timeout.js';

test('deadline also rejects when headers arrive but the body never completes',async(t)=>{
  t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1]));}})));
  await assert.rejects(fetchWithTimeout('https://example.invalid',{},20,'body'),UpstreamTimeoutError);
});

test('buffered response preserves status, headers and readable body',async(t)=>{
  t.mock.method(globalThis,'fetch',async()=>new Response('{"ok":true}',{status:201,headers:{'x-test':'yes'}}));
  const response=await fetchWithTimeout('https://example.invalid',{},100,'body');
  assert.equal(response.status,201);
  assert.equal(response.headers.get('x-test'),'yes');
  assert.deepEqual(await response.json(),{ok:true});
});

test('fetchWithTimeout aborts a stalled upstream request',async()=>{
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(_url,init)=>new Promise((resolve,reject)=>{
    init.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
  });
  try{
    const started=Date.now();
    await assert.rejects(
      fetchWithTimeout('https://example.invalid',{},20,'test upstream'),
      (error)=>error instanceof UpstreamTimeoutError && error.timeoutMs===20,
    );
    assert.ok(Date.now()-started<500);
  }finally{
    globalThis.fetch=originalFetch;
  }
});
