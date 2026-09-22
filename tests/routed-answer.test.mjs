import test from 'node:test';
import assert from 'node:assert/strict';
import { routedAnswer, isSimpleGreeting } from '../.test-dist/routed-answer.js';

const env = { GEMINI_API_KEY:'test', GEMINI_MODEL:'gemini-flash-latest' };
const interaction = value => new Response(JSON.stringify({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:JSON.stringify(value)}]}]}));
const plain = {search:false,start_date:'',end_date:'',location:'',public_keywords:[],answer:'はい、どうしました？'};

test('ordinary replies need exactly one generation, with full conversation preserved', async t => {
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url, init)=>{
    calls.push({url, body:JSON.parse(init.body)});
    return interaction(plain);
  });
  const result=await routedAnswer(env,'system','previous conversation\nおい',[],'low',Date.now());
  assert.equal(result.text,plain.answer);
  assert.equal(calls.length,1);
  assert.equal(calls[0].body.model,'gemini-flash-latest');
  assert.equal(calls[0].body.input[0].text,'previous conversation\nおい');
  assert.equal(calls[0].body.response_format.schema.properties.answer.type,'string');
});

test('contextual tomorrow follow-up routes directly to grounded search without a second classifier',async t=>{
  let calls=0;
  const DB={prepare(){return {bind(){return this;},async all(){return {results:[]};},async first(){return {value:'1'};}};}};
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    calls++;
    if(calls===1){
      assert.match(JSON.parse(init.body).input[0].text,/明日は/);
      return interaction({...plain,search:true,answer:'',start_date:'2026-09-23',end_date:'2026-09-23',location:'静岡県浜松市'});
    }
    assert.match(url,/gemini-2.5-flash:generateContent$/);
    assert.match(JSON.parse(init.body).contents[0].parts[0].text,/2026-09-23/);
    return new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:'9月23日の催事です。'}]},groundingMetadata:{webSearchQueries:['浜松'],groundingChunks:[{web:{title:'公式',uri:'https://example.org/event'}}],groundingSupports:[{groundingChunkIndices:[0]}]}}]}));
  });
  const result=await routedAnswer({...env,DB},'system','浜松のイベントの話\n明日は？',[],'medium',Date.parse('2026-09-22T00:00:00Z'));
  assert.equal(calls,2);
  assert.match(result.text,/参照リンク/);
  assert.match(result.text,/https:\/\/example.org\/event/);
});

test('malformed route never leaks JSON or launches a search',async t=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return interaction({search:'false',answer:'unsafe'});});
  const result=await routedAnswer(env,'system','hi',[],'low',Date.now());
  assert.equal(calls,1);
  assert.match(result.text,/形式/);
  assert.ok(!result.text.includes('unsafe'));
});

test('only unambiguous standalone greetings take the lightweight media/reasoning path',()=>{
  for(const value of ['おい','@HOME-AI おい','こんにちは！'])assert.equal(isSimpleGreeting(value),true);
  for(const value of ['明日は？','それは？','おい 今日何する？','この写真どう？'])assert.equal(isSimpleGreeting(value),false);
});
