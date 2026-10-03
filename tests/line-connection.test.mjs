import test from 'node:test';
import assert from 'node:assert/strict';
import {checkLineConnection,getMessageContent} from '../.test-dist/line.js';
const expected='https://line-home-ai.kitworks.workers.dev/webhook';
const env={LINE_CHANNEL_ID:'synthetic',LINE_CHANNEL_SECRET:'synthetic',MEDIA_MAX_FILE_BYTES:'16777216'};
function mock(t,endpoint,active,testSuccess=true){
 const calls=[];
 t.mock.method(globalThis,'fetch',async(url,init={})=>{
  calls.push([String(url),init]);
  if(String(url).includes('/oauth2/'))return Response.json({access_token:'synthetic-token',expires_in:900});
  if(String(url).endsWith('/info'))return Response.json({displayName:'Synthetic'});
  if(String(url).endsWith('/endpoint'))return Response.json({endpoint,active});
  if(String(url).endsWith('/test'))return Response.json({success:testSuccess,statusCode:testSuccess?200:403});
  if(String(url).endsWith('/consumption'))return Response.json({totalUsage:7});
  if(String(url).endsWith('/quota'))return Response.json({type:'limited',value:200});
  if(String(url).includes('api-data'))return new Response(null,{status:202});
  throw new Error('Unexpected request');
 });return calls;
}
test('LINE check differentiates active, route match and signed platform delivery',async t=>{
 const calls=mock(t,expected,true);const result=await checkLineConnection(env);
 assert.equal(result.webhook,true);assert.equal(result.webhookTest,true);assert.equal(result.freeMessagesRemaining,193);
 const probe=calls.find(([url])=>url.endsWith('/test'));assert.deepEqual(JSON.parse(probe[1].body),{endpoint:expected});
 assert.ok(!JSON.stringify(result).includes('synthetic-token'));
});
test('disabled LINE webhooks are not masked by a successful endpoint test',async t=>{
 mock(t,expected,false);const result=await checkLineConnection(env);assert.equal(result.webhook,false);assert.equal(result.webhookActive,false);assert.equal(result.endpointMatches,true);assert.equal(result.webhookTest,true);
});
test('incorrect URL is reported without exposing query secrets or accepting a different route',async t=>{
 mock(t,expected+'?token=secret',true);const result=await checkLineConnection(env);assert.equal(result.webhook,false);assert.equal(result.webhookActive,true);assert.equal(result.endpointMatches,false);assert.equal(result.endpointPath,'/webhook');assert.ok(!JSON.stringify(result).includes('token='));
});
test('failed platform delivery prevents successful webhook verification',async t=>{
 mock(t,expected,true,false);const result=await checkLineConnection(env);assert.equal(result.webhook,false);assert.equal(result.webhookTestStatus,403);
});
test('pending LINE video content is retried instead of saving an empty attachment',async t=>{
 mock(t,expected,true);await assert.rejects(getMessageContent(env,'pending-video'),/still processing/);
});
test('explicit admin repair updates only the known obsolete Home AI endpoint',async t=>{
 let endpoint='https://line-home-ai.ii-kt.workers.dev/webhook',writes=0;
 t.mock.method(globalThis,'fetch',async(url,init={})=>{
  const u=String(url);
  if(u.includes('/oauth2/'))return Response.json({access_token:'synthetic-token',expires_in:900});
  if(u.endsWith('/info'))return Response.json({});
  if(u.endsWith('/endpoint')){if(init.method==='PUT'){endpoint=JSON.parse(init.body).endpoint;writes++;return Response.json({});}return Response.json({endpoint,active:true});}
  if(u.endsWith('/test'))return Response.json({success:true,statusCode:200});
  if(u.endsWith('/consumption'))return Response.json({totalUsage:0});
  if(u.endsWith('/quota'))return Response.json({type:'limited',value:200});
  throw new Error('Unexpected request');
 });
 const result=await checkLineConnection(env,true);assert.equal(result.legacyEndpointUpdated,true);assert.equal(result.webhook,true);assert.equal(writes,1);assert.equal(endpoint,expected);
});
test('read-only checks never change even the known legacy endpoint',async t=>{
 const calls=mock(t,'https://line-home-ai.ii-kt.workers.dev/webhook',true);const result=await checkLineConnection(env);assert.equal(result.legacyEndpointUpdated,false);assert.ok(calls.every(([,init])=>init.method!=='PUT'));
});
test('repair mode cannot overwrite an unrelated custom endpoint',async t=>{
 const calls=mock(t,'https://example.invalid/custom-webhook',true);const result=await checkLineConnection(env,true);assert.equal(result.legacyEndpointUpdated,false);assert.equal(result.webhook,false);assert.ok(calls.every(([,init])=>init.method!=='PUT'));
});
