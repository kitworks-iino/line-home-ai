import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaEnv, SqliteD1 } from './helpers/sqlite-d1.mjs';
import { ensureSchema } from '../.test-dist/schema.js';
import { bindGroup, getBoundGroup } from '../.test-dist/db.js';
import { processQueuePayload } from '../.test-dist/processor.js';
import worker,{verifyLineSignature} from '../.test-dist/index.js';
import { mediaStore } from '../.test-dist/media-store.js';
async function fixture(t,extra={}){
 const calls=[];const env={...mediaEnv(),DB:new SqliteD1(),LINE_CHANNEL_ID:'test-id',LINE_CHANNEL_SECRET:'test-secret',SETUP_CODE:'test-setup',GEMINI_API_KEY:'test-key',GEMINI_MODEL:'test-model',GEMINI_FALLBACK_MODELS:'',DEFAULT_THINKING_LEVEL:'medium',MEMORY_BATCH_SIZE:'24',RECENT_MESSAGE_LIMIT:'40',MAX_MEDIA_CONTEXT:'3',IMPLICIT_FOLLOWUP_WINDOW_MS:'600000',EVENT_QUEUE:{sent:[],async send(x){this.sent.push(x);}},MEMORY_QUEUE:{sent:[],async send(x){this.sent.push(x);}},...extra};await ensureSchema(env);await mediaStore(env).usage();await bindGroup(env,'Ctest','Utest','Test member','medium');
 t.mock.method(globalThis,'fetch',async(url,init={})=>{const u=String(url);calls.push([u,init]);if(u.includes('/oauth2/'))return Response.json({access_token:'test-token',expires_in:900});if(u.includes('api-data.line.me'))return new Response('synthetic attachment',{headers:{'content-type':'text/plain'}});if(u.includes('generativelanguage.googleapis.com'))return Response.json({status:'completed',model:'test-model',steps:[{type:'model_output',content:[{type:'text',text:'合成データを確認しました。'}]}]});if(u.endsWith('/reply')||u.endsWith('/push'))return Response.json({sentMessages:[{id:'bot-'+calls.length}]});throw new Error('Unexpected external endpoint '+u);});
 const payload=(id,message,more={})=>({destination:'test-bot',receivedAt:Date.now(),event:{type:'message',timestamp:Date.now(),webhookEventId:'event-'+id,source:{type:'group',groupId:'Ctest',userId:'Utest'},replyToken:'reply-'+id,message:{id,...message},...more}});return {env,calls,payload};
}
test('attachment persists in D1, follow-up passes it to Gemini, and redelivery is idempotent',async t=>{
 const {env,calls,payload}=await fixture(t);const incoming=payload('file1',{type:'file',fileName:'test.txt'});await processQueuePayload(env,incoming);await processQueuePayload(env,incoming);assert.equal(calls.filter(([u])=>u.includes('api-data')).length,1);assert.equal((await mediaStore(env).usage()).objects,1);assert.equal(env.DB.sqlite.prepare("SELECT * FROM messages WHERE line_message_id='file1'").get().media_key,'groups/Ctest/media/file1');await processQueuePayload(env,payload('question',{type:'text',text:'AI、添付の内容を教えて'}));const ai=calls.find(([u])=>u.includes('/interactions'));assert.ok(ai);assert.match(ai[1].body,/synthetic attachment/);assert.ok(calls.some(([u])=>u.endsWith('/reply')));assert.equal(await getBoundGroup(env),'Ctest');
});
test('file rejection notifies LINE and never stores fake attachment bytes',async t=>{
 const {env,calls,payload}=await fixture(t,{MEDIA_MAX_FILE_BYTES:'5'});await processQueuePayload(env,payload('large',{type:'video'}));assert.equal((await mediaStore(env).usage()).objects,0);const row=env.DB.sqlite.prepare("SELECT * FROM messages WHERE line_message_id='large'").get();assert.equal(row.media_key,null);assert.match(row.text,/保存していません/);assert.match(calls.find(([u])=>u.endsWith('/reply'))[1].body,/保存していません/);assert.ok(!calls.some(([u])=>u.includes('generativelanguage')));
});
test('unsend removes attachment and a retry cannot restore it',async t=>{
 const {env,payload}=await fixture(t);await processQueuePayload(env,payload('a',{type:'image'}));await processQueuePayload(env,payload('cancel',undefined,{type:'unsend',message:undefined,unsend:{messageId:'a'}}));assert.equal(await mediaStore(env).get('groups/Ctest/media/a'),null);await processQueuePayload(env,payload('retry',{id:'a',type:'image'}));assert.equal((await mediaStore(env).usage()).objects,0);assert.equal(env.DB.sqlite.prepare("SELECT unsent FROM messages WHERE line_message_id='a'").get().unsent,1);
});
test('cancellation before delayed attachment prevents saving and model calls',async t=>{
 const {env,calls,payload}=await fixture(t);await processQueuePayload(env,payload('cancel',undefined,{type:'unsend',message:undefined,unsend:{messageId:'later'}}));await processQueuePayload(env,payload('later',{type:'image'}));assert.equal((await mediaStore(env).usage()).objects,0);assert.equal(env.DB.sqlite.prepare("SELECT unsent FROM messages WHERE line_message_id='later'").get().unsent,1);assert.ok(!calls.some(([u])=>u.endsWith('/reply')||u.includes('/interactions')));
});
test('unauthorized group cannot download or save attachments',async t=>{
 const {env,calls,payload}=await fixture(t);await processQueuePayload(env,payload('intruder',{type:'image'},{source:{type:'group',groupId:'Other',userId:'Other'}}));assert.equal((await mediaStore(env).usage()).objects,0);assert.equal(calls.length,0);
});
test('signed empty webhook succeeds and invalid signatures never queue',async t=>{
 const {env}=await fixture(t);const body=JSON.stringify({events:[]});const sk=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.LINE_CHANNEL_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);const sig=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC',sk,new TextEncoder().encode(body)))));assert.equal(await verifyLineSignature(body,sig,env.LINE_CHANNEL_SECRET),true);let res=await worker.fetch(new Request('https://test/webhook',{method:'POST',body,headers:{'x-line-signature':sig}}),env);assert.equal(res.status,200);assert.equal(env.EVENT_QUEUE.sent.length,0);res=await worker.fetch(new Request('https://test/webhook',{method:'POST',body,headers:{'x-line-signature':'bad'}}),env);assert.equal(res.status,401);assert.equal(env.EVENT_QUEUE.sent.length,0);
});
test('/usage reports D1 and /delete-data clears the isolated test household',async t=>{
 const {env,calls,payload}=await fixture(t);await processQueuePayload(env,payload('a',{type:'file'}));await processQueuePayload(env,payload('usage',{type:'text',text:'/usage'}));assert.ok(calls.some(([,i])=>typeof i.body==='string'&&i.body.includes('D1 添付ストレージ')));await processQueuePayload(env,payload('delete',{type:'text',text:'/delete-data DELETE ALL'}));assert.equal((await mediaStore(env).usage()).objects,0);assert.equal(await getBoundGroup(env),null);assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM messages').get().n,0);
});
