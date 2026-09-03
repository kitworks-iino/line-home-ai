import test from 'node:test';
import assert from 'node:assert/strict';
import { canStoreWithinR2Limit, formatDecimalBytes, r2HardLimitBytes, r2StorageUsage } from '../.test-dist/r2-guard.js';

test('R2 storage guard uses the full configured limit with no arbitrary headroom',()=>{
  assert.equal(canStoreWithinR2Limit(9_000_000_000,1_000_000_000,10_000_000_000),true);
  assert.equal(canStoreWithinR2Limit(9_999_999_999,1,10_000_000_000),true);
  assert.equal(canStoreWithinR2Limit(9_999_999_999,2,10_000_000_000),false);
  assert.equal(canStoreWithinR2Limit(10_000_000_000,0,10_000_000_000),true);
  assert.equal(canStoreWithinR2Limit(10_000_000_000,1,10_000_000_000),false);
});

test('R2 hard limit defaults to the official 10 GB storage free-tier value',()=>{
  assert.equal(r2HardLimitBytes({R2_STORAGE_HARD_LIMIT_BYTES:'10000000000'}),10_000_000_000);
  assert.equal(r2HardLimitBytes({R2_STORAGE_HARD_LIMIT_BYTES:'bad'}),10_000_000_000);
});

test('R2 usage sums actual listed object sizes across pagination',async()=>{
  const pages=[
    {objects:[{size:125},{size:375}],truncated:true,cursor:'next'},
    {objects:[{size:500}],truncated:false},
  ];
  let calls=0;
  const env={MEDIA:{list:async()=>pages[calls++]}};
  const usage=await r2StorageUsage(env);
  assert.deepEqual(usage,{bytes:1000,objects:3,listOperations:2});
});

test('decimal byte formatting matches Cloudflare GB terminology',()=>{
  assert.equal(formatDecimalBytes(10_000_000_000),'10.000 GB');
  assert.equal(formatDecimalBytes(500_000_000),'500.0 MB');
});
