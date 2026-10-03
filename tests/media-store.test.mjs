import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaEnv } from './helpers/sqlite-d1.mjs';
import { mediaStore, MEDIA_CHUNK_BYTES, MEDIA_FILE_BYTES, mediaDigest, MediaLimitError, readBoundedMedia } from '../.test-dist/media-store.js';
import { mediaInputs } from '../.test-dist/gemini.js';
const key=n=>`groups/test/media/${n}`;
const buffer=t=>new TextEncoder().encode(t).buffer;

test('D1 media persists actual bytes and metadata without R2',async()=>{
 const env=mediaEnv(),s=mediaStore(env);await s.put(key('a'),buffer('日本語の添付'),{contentType:'text/plain'});
 const o=await s.get(key('a'));assert.equal(new TextDecoder().decode(await o.arrayBuffer()),'日本語の添付');assert.equal(o.contentType,'text/plain');assert.equal((await s.usage()).objects,1);assert.equal(env.MEDIA,undefined);
});
test('multi-chunk round trip with encoded rows below the D1 row limit',async()=>{
 const env=mediaEnv(),s=mediaStore(env),b=new Uint8Array(MEDIA_CHUNK_BYTES*2+37);for(let i=0;i<b.length;i++)b[i]=i%251;
 await s.put(key('large'),b.buffer,{contentType:'video/mp4'});const rows=env.MEDIA_DB.sqlite.prepare('SELECT length(data) n FROM media_chunks').all();assert.equal(rows.length,3);assert.ok(rows.every(r=>r.n<2_000_000));assert.deepEqual(new Uint8Array(await (await s.get(key('large'))).arrayBuffer()),b);
});
test('zero bytes, exact maximum file size and one byte too many',async()=>{
 const env=mediaEnv(),s=mediaStore(env);await s.put(key('empty'),new ArrayBuffer(0),{contentType:'application/octet-stream'});assert.equal((await (await s.get(key('empty'))).arrayBuffer()).byteLength,0);
 const b=new Uint8Array(MEDIA_FILE_BYTES);b[b.length-1]=7;await s.put(key('boundary'),b.buffer,{contentType:'application/octet-stream'});assert.equal(await mediaDigest(await (await s.get(key('boundary'))).arrayBuffer()),await mediaDigest(b.buffer));await assert.rejects(s.put(key('too-big'),new ArrayBuffer(MEDIA_FILE_BYTES+1),{contentType:'video/mp4'}),e=>e.code==='file_limit');assert.equal((await s.usage()).objects,2);
});
test('atomic capacity check allows exact boundary and does not charge duplicates',async()=>{
 const env={...mediaEnv(),MEDIA_STORAGE_LIMIT_BYTES:'6'},s=mediaStore(env);for(const [id,value]of [['a','123'],['b','456'],['a','123']])await s.put(key(id),buffer(value),{contentType:'text/plain'});
 await assert.rejects(s.put(key('c'),buffer('7'),{contentType:'text/plain'}),e=>e.code==='capacity');assert.equal((await s.usage()).bytes,6);assert.equal((await s.usage()).objects,2);assert.equal(await s.get(key('c')),null);assert.equal(env.MEDIA_DB.sqlite.prepare('SELECT COUNT(*) n FROM media_chunks').get().n,2);
});
test('partial failure rolls back metadata, chunks, and accounting',async()=>{
 const env=mediaEnv(),s=mediaStore(env);await s.usage();env.MEDIA_DB.inject=sql=>sql.includes('INSERT OR IGNORE INTO media_chunks');await assert.rejects(s.put(key('a'),buffer('hello'),{contentType:'text/plain'}),/injected/);env.MEDIA_DB.inject=null;assert.equal(await s.get(key('a')),null);assert.equal((await s.usage()).bytes,0);await s.put(key('a'),buffer('hello'),{contentType:'text/plain'});assert.equal((await s.usage()).bytes,5);
});
test('conflicting same-key writes preserve original data',async()=>{
 const env=mediaEnv(),s=mediaStore(env);await s.put(key('a'),buffer('first'),{contentType:'text/plain'});await assert.rejects(s.put(key('a'),buffer('other'),{contentType:'text/plain'}),/collision/);assert.equal(new TextDecoder().decode(await (await s.get(key('a'))).arrayBuffer()),'first');assert.equal((await s.usage()).bytes,5);
});
test('idempotent delete prevents late retries restoring unsent attachments',async()=>{
 const env=mediaEnv(),s=mediaStore(env);await s.put(key('a'),buffer('data'),{contentType:'text/plain'});await s.delete(key('a'));await s.delete(key('a'));await assert.rejects(s.put(key('a'),buffer('data'),{contentType:'text/plain'}),e=>e.code==='cancelled');assert.equal(await s.get(key('a')),null);assert.equal((await s.usage()).bytes,0);assert.equal(env.MEDIA_DB.sqlite.prepare('SELECT COUNT(*) n FROM media_chunks').get().n,0);
});
test('household deletion is scoped to that household',async()=>{
 const env=mediaEnv(),s=mediaStore(env);await s.put(key('a'),buffer('data'),{contentType:'text/plain'});await s.put('groups/other/media/a',buffer('retain'),{contentType:'text/plain'});await s.delete(key('cancelled'));await s.deleteGroup('test');assert.equal((await s.usage()).bytes,6);assert.ok(await s.get('groups/other/media/a'));assert.equal(env.MEDIA_DB.sqlite.prepare('SELECT COUNT(*) n FROM media_tombstones WHERE group_id=?').get('test').n,0);
});
test('corrupt or incomplete attachments cannot become successful model inputs',async()=>{
 const env=mediaEnv(),s=mediaStore(env);await s.put(key('a'),buffer('first'),{contentType:'text/plain'});env.MEDIA_DB.sqlite.prepare('UPDATE media_chunks SET data=? WHERE object_key=?').run(btoa('other'),key('a'));await assert.rejects((await s.get(key('a'))).arrayBuffer(),/integrity/);const messages=[{line_message_id:'a',media_key:key('a'),mime_type:'text/plain',sender_name:'Test',type:'file',unsent:0}];assert.match((await mediaInputs(env,messages,1)).inputs[0].text,/参照できません/);env.MEDIA_DB.sqlite.prepare('DELETE FROM media_chunks WHERE object_key=?').run(key('a'));await assert.rejects((await s.get(key('a'))).arrayBuffer(),/Incomplete/);
});
test('oversized advertised or unadvertised streams are cancelled before full buffering',async()=>{
 await assert.rejects(readBoundedMedia(new Response('abcdef',{headers:{'content-length':'6'}}),5),e=>e instanceof MediaLimitError&&e.code==='file_limit');let cancelled=false;const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(3));c.enqueue(new Uint8Array(3));},cancel(){cancelled=true;}});await assert.rejects(readBoundedMedia(new Response(stream),5),e=>e.code==='file_limit');assert.equal(cancelled,true);assert.equal(new TextDecoder().decode(await readBoundedMedia(new Response('abc'),3)),'abc');
});
