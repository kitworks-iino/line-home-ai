import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyLineSignature } from '../.test-dist/index.js';

test("LINE's published HMAC-SHA256 signature example",async()=>{
  const body='{"destination":"U8e742f61d673b39c7fff3cecb7536ef0","events":[]}';
  const signature='GhRKmvmHys4Pi8DxkF4+EayaH0OqtJtaZxgTD9fMDLs=';
  assert.equal(await verifyLineSignature(body,signature,'8c570fa6dd201bb328f1c1eac23a96d8'),true);
  assert.equal(await verifyLineSignature(body,signature,'wrong'),false);
});
