import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithTimeout, UpstreamTimeoutError } from '../.test-dist/timeout.js';

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
