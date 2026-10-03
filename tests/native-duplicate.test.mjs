import test from 'node:test';
import assert from 'node:assert/strict';
import {mediaEnv} from './helpers/sqlite-d1.mjs';
import {mediaStore} from '../.test-dist/media-store.js';
test('duplicate deliveries do not rewrite chunks or reserve capacity again',async()=>{
  const env=mediaEnv(),store=mediaStore(env),key='groups/test/media/duplicate-fast';
  const bytes=new TextEncoder().encode('data').buffer;
  await store.put(key,bytes,{contentType:'text/plain'});
  env.MEDIA_DB.inject=sql=>sql.includes('INSERT INTO media_objects')||sql.includes('INSERT OR IGNORE INTO media_chunks');
  await store.put(key,bytes,{contentType:'text/plain'});
  assert.equal((await store.usage()).objects,1);
  assert.equal((await store.usage()).bytes,4);
});
