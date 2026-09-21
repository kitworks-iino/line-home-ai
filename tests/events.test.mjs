import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calendarDate, eventAnswer, eventIntentInstruction, groundedEventText,
  normalizeEventIntent, publicSearchPrompt, reserveSearchRequest, SEARCH_DAILY_CAP,
} from '../.test-dist/events.js';

const intent = { search:true, start_date:'2026-09-22', end_date:'2026-09-22', location:'静岡県浜松市', public_keywords:[] };
const response = (value, status=200) => new Response(JSON.stringify(value), { status });
const interaction = (value) => response({ status:'completed', steps:[{type:'model_output', content:[{type:'text', text:JSON.stringify(value)}]}] });
const grounded = (overrides={}) => ({ candidates:[{
  finishReason:'STOP',
  content:{parts:[{text:'2026年9月22日、浜松市で開催されるイベントです。\nテスト催事 10:00〜16:00。'}]},
  groundingMetadata:{
    webSearchQueries:['浜松市 2026年9月22日 イベント'],
    groundingChunks:[{web:{title:'主催者の開催案内', uri:'https://example.org/events/20260922'}}],
    groundingSupports:[{groundingChunkIndices:[0]}],
    searchEntryPoint:{renderedContent:'<div><a href="https://www.google.com/search?q=hamamatsu&amp;date=20260922">浜松市のイベント</a></div>'},
  },
  ...overrides,
}] });

function database({ count=0, broken=false, blocks=[] }={}) {
  const state = { count, writes:[], reservations:[] };
  return {
    state,
    prepare(sql) {
      let params=[];
      return {
        bind(...values) { params=values; return this; },
        async all() { if(broken) throw new Error('DB unavailable'); return {results:blocks,success:true}; },
        async run() { if(broken) throw new Error('DB unavailable'); state.writes.push(params); return {success:true}; },
        async first() {
          if(broken) throw new Error('DB unavailable');
          assert.match(sql, /ON CONFLICT\(key\) DO UPDATE/);
          assert.match(sql, /RETURNING value/);
          state.reservations.push(params);
          if(state.count >= params[2]) return null;
          state.count++;
          return {value:String(state.count)};
        },
      };
    },
  };
}

test('JST date anchors use the question timestamp across midnight, month and year boundaries', () => {
  assert.equal(calendarDate(Date.parse('2026-09-21T15:00:00Z')), '2026-09-22');
  assert.equal(calendarDate(Date.parse('2026-09-21T14:59:59Z')), '2026-09-21');
  const instruction=eventIntentInstruction(Date.parse('2026-12-31T14:59:59Z'));
  assert.match(instruction, /今日=2026-12-31、明日=2027-01-01、明後日=2027-01-02/);
  assert.match(instruction, /Asia\/Tokyo/);
});

test('invalid dates and private search identifiers never reach Google Search', () => {
  assert.equal(normalizeEventIntent({search:false}), null);
  assert.throws(()=>normalizeEventIntent({...intent,start_date:'2026-02-30'}));
  assert.throws(()=>normalizeEventIntent({...intent,end_date:'2026-09-21'}));
  assert.throws(()=>normalizeEventIntent({...intent,end_date:'2027-09-22'}));
  assert.throws(()=>normalizeEventIntent({...intent,public_keywords:['user_id=U0123456789abcdef0123456789abcdef']}));
  assert.throws(()=>normalizeEventIntent({...intent,location:'a@example.org'}));
  assert.equal(normalizeEventIntent({...intent,location:''}).location,'静岡県浜松市');
});

test('event search receives public extracted conditions instead of the family conversation', async(t) => {
  const calls=[];
  const db=database();
  const privatePrompt='【長期記憶】家庭の秘密SECRET。\n【直近会話】太郎:今日どこか行く？\n太郎:明日は？ message_id=private-id';
  t.mock.method(globalThis,'fetch',async(url, init)=>{
    calls.push({url:String(url),body:JSON.parse(init.body)});
    return calls.length===1 ? interaction(intent) : response(grounded());
  });
  const result=await eventAnswer({DB:db,GEMINI_API_KEY:'test'},privatePrompt,Date.parse('2026-09-21T02:00:00Z'));
  assert.equal(calls[0].body.input,privatePrompt);
  assert.equal(calls[0].body.store,false);
  assert.equal(calls[0].body.model,'gemini-3.5-flash-lite');
  assert.match(calls[0].body.system_instruction,/明日=2026-09-22/);
  assert.match(calls[1].url,/models\/gemini-2.5-flash:generateContent$/);
  assert.deepEqual(calls[1].body.tools,[{google_search:{}}]);
  const searchBody=JSON.stringify(calls[1].body);
  assert.doesNotMatch(searchBody,/SECRET|太郎|private-id/);
  assert.match(searchBody,/2026-09-22/);
  assert.match(result,/https:\/\/example.org\/events\/20260922/);
  assert.match(result,/https:\/\/www.google.com\/search\?q=hamamatsu&date=20260922/);
  assert.equal(db.state.count,1);
});

test('a non-event LLM decision returns to conversation without a search or budget reservation', async(t) => {
  const db=database();
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++; return interaction({search:false});});
  assert.equal(await eventAnswer({DB:db,GEMINI_API_KEY:'test'},'今日の仕事のToDoは？'),null);
  assert.equal(calls,1);
  assert.equal(db.state.count,0);
});

test('explicit location and previous-event details are preserved as public conditions', () => {
  const parsed=normalizeEventIntent({...intent,location:'焼津市',public_keywords:['港のお祭り','開催時間','屋内']});
  const prompt=publicSearchPrompt(parsed);
  assert.match(prompt,/焼津市/);
  assert.match(prompt,/港のお祭り/);
  assert.match(prompt,/開催時間/);
  assert.doesNotMatch(prompt,/浜松市/);
});

test('search quota falls back to the other free 2.5 model and reserves both attempts', async(t) => {
  const db=database();
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    calls.push(String(url));
    if(calls.length===1) return interaction(intent);
    if(calls.length===2) return response({error:{message:'Quota exceeded per day'}},429);
    return response(grounded());
  });
  const result=await eventAnswer({DB:db,GEMINI_API_KEY:'test'},'イベントある？');
  assert.match(calls[1],/gemini-2.5-flash:/);
  assert.match(calls[2],/gemini-2.5-flash-lite:/);
  assert.equal(db.state.count,2);
  assert.ok(db.state.writes.some(values=>values[0]==='gemini_quota:gemini-2.5-flash'));
  assert.match(result,/参照リンク/);
});

test('intent quota is persisted and classification can use the configured conversation model', async(t) => {
  const db=database();
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    const body=JSON.parse(init.body);
    calls.push(body.model ?? String(url));
    if(calls.length===1) return response({error:{message:'Quota exceeded per minute'}},429);
    if(calls.length===2) return interaction(intent);
    return response(grounded());
  });
  const result=await eventAnswer({DB:db,GEMINI_API_KEY:'test',GEMINI_MODEL:'gemini-3.8-flash'},'今日何する？');
  assert.deepEqual(calls.slice(0,2),['gemini-3.5-flash-lite','gemini-3.8-flash']);
  assert.ok(db.state.writes.some(values=>values[0]==='gemini_quota:gemini-3.5-flash-lite'));
  assert.match(result,/参照リンク/);
});

test('missing grounding, uncited links, invented URLs and incomplete output are not event answers', () => {
  assert.equal(groundedEventText({candidates:[{content:{parts:[{text:'今日は花火大会です'}]}}]}),null);
  const unsupported=grounded();
  unsupported.candidates[0].groundingMetadata.groundingSupports=[];
  assert.equal(groundedEventText(unsupported),null);
  const invented=grounded({content:{parts:[{text:'架空 https://invented.example.org/event'}]}});
  assert.equal(groundedEventText(invented),null);
  assert.equal(groundedEventText(grounded({finishReason:'MAX_TOKENS'})),null);
});

test('a successful HTTP response without actual search evidence is retried then reported as unverified', async(t) => {
  const db=database();
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{
    calls++;
    return calls===1 ? interaction(intent) : response({candidates:[{content:{parts:[{text:'架空イベントが開催されます'}]}}]});
  });
  const result=await eventAnswer({DB:db,GEMINI_API_KEY:'test'},'イベントある？');
  assert.equal(calls,3);
  assert.equal(db.state.count,2);
  assert.match(result,/検索を完了できませんでした/);
  assert.doesNotMatch(result,/架空イベント/);
});

test('the daily cap and unavailable budget store fail closed before Google Search', async(t) => {
  for (const db of [database({count:SEARCH_DAILY_CAP}),database({broken:true}),undefined]) {
    let calls=0;
    t.mock.method(globalThis,'fetch',async()=>{calls++;return interaction(intent);});
    const result=await eventAnswer({DB:db,GEMINI_API_KEY:'test'},'今日のイベントある？');
    assert.equal(calls,1);
    assert.match(result,/無料利用枠を保護/);
    t.mock.restoreAll();
  }
});

test('budget day follows Pacific reset including DST, independently of JST question date', async() => {
  const summer=database();
  await reserveSearchRequest({DB:summer},Date.parse('2026-09-22T06:59:59Z'));
  await reserveSearchRequest({DB:summer},Date.parse('2026-09-22T07:00:00Z'));
  assert.equal(summer.state.reservations[0][0],'google_search_usage:2026-09-21');
  assert.equal(summer.state.reservations[1][0],'google_search_usage:2026-09-22');
  const winter=database();
  await reserveSearchRequest({DB:winter},Date.parse('2026-12-22T07:59:59Z'));
  await reserveSearchRequest({DB:winter},Date.parse('2026-12-22T08:00:00Z'));
  assert.equal(winter.state.reservations[0][0],'google_search_usage:2026-12-21');
  assert.equal(winter.state.reservations[1][0],'google_search_usage:2026-12-22');
});

test('SDK search suggestions preserve Google-provided Japanese labels and URLs', () => {
  const result=grounded();
  result.candidates[0].groundingMetadata.searchEntryPoint={sdkBlob:Buffer.from(JSON.stringify([['浜松の催事','https://www.google.com/search?q=events']])).toString('base64')};
  const text=groundedEventText(result);
  assert.match(text,/Google検索の候補\n浜松の催事\nhttps:\/\/www.google.com\/search\?q=events/);
  result.candidates[0].groundingMetadata.searchEntryPoint={renderedContent:'<script>bad()</script>'};
  assert.equal(groundedEventText(result),null);
});
