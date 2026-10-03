import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import assert from 'node:assert/strict';

const source = `
import { mediaStore, mediaDigest } from './src/media-store.ts';
export default { async fetch(request,env) {
  const size=Number(new URL(request.url).searchParams.get('size'));
  const store=mediaStore(env), group='runtime-test', key='groups/'+group+'/media/test';
  const sample=new Uint8Array(size); for(let i=0;i<sample.length;i++) sample[i]=i%251;
  await store.put(key,sample.buffer,{contentType:'application/octet-stream'});
  const stored=await store.get(key);
  const correct=await mediaDigest(await stored.arrayBuffer())===await mediaDigest(sample.buffer);
  await store.put(key,sample.buffer,{contentType:'application/octet-stream'});
  const usage=await store.usage();
  await store.delete(key);
  let prevented=false; try { await store.put(key,sample.buffer,{contentType:'application/octet-stream'}); } catch(e) { prevented=e.code==='cancelled'; }
  await store.deleteGroup(group);
  return Response.json({correct,prevented,usage,after:await store.usage(),r2Absent:!('MEDIA' in env)});
}};`;
const output=await build({stdin:{contents:source,resolveDir:process.cwd(),sourcefile:'runtime-entry.ts',loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
const mf=new Miniflare({workers:[{name:'storage-test',modules:true,script:output.outputFiles[0].text,compatibilityDate:'2026-09-03',d1Databases:{MEDIA_DB:'test-media-db'}}]});
try {
  for(const size of [0,1024*1024+17,16*1024*1024]) {
    const response=await mf.dispatchFetch('https://runtime.test/?size='+size);
    const body=await response.text();
    assert.equal(response.status,200,body);
    const result=JSON.parse(body);
    assert.equal(result.correct,true); assert.equal(result.prevented,true); assert.equal(result.r2Absent,true);
    assert.equal(result.usage.objects,1); assert.equal(result.usage.bytes,size); assert.equal(result.after.objects,0);
    console.log('PASS workerd + D1 round-trip, duplicate, delete and cancellation: '+size+' bytes');
  }
} finally { await mf.dispose(); }
