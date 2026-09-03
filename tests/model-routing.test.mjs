import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allModelsExhaustedNotice,
  conversationModels,
  fallbackNotice,
  memoryModel,
  modelDisplayName,
  nextPacificQuotaResetMs,
  quotaBlockFrom429,
} from '../.test-dist/model-routing.js';

test('conversation routing keeps latest alias first and deduplicates fallbacks',()=>{
  const models=conversationModels({
    GEMINI_MODEL:'gemini-flash-latest',
    GEMINI_FALLBACK_MODELS:'gemini-3.7-flash, gemini-3.6-flash,gemini-3.7-flash',
  });
  assert.deepEqual(models,['gemini-flash-latest','gemini-3.7-flash','gemini-3.6-flash']);
});

test('memory model is independent from conversation primary model',()=>{
  assert.equal(memoryModel({GEMINI_MEMORY_MODEL:'gemini-3.5-flash-lite'}),'gemini-3.5-flash-lite');
});

test('model names and fallback notice are readable in LINE',()=>{
  assert.equal(modelDisplayName('gemini-flash-latest'),'Gemini Flash 最新版');
  assert.equal(modelDisplayName('gemini-3.7-flash'),'Gemini 3.7 Flash');
  assert.equal(modelDisplayName('gemini-3.5-flash-lite'),'Gemini 3.5 Flash-Lite');
  const notice=fallbackNotice(['gemini-flash-latest','gemini-3.7-flash'],'gemini-3.6-flash');
  assert.match(notice,/Gemini Flash 最新版 → Gemini 3\.7 Flash → Gemini 3\.6 Flash/);
  assert.match(notice,/今回は Gemini 3\.6 Flash が対応します/);
});

test('all-exhausted notice includes unavailable model chain',()=>{
  const notice=allModelsExhaustedNotice(['gemini-flash-latest','gemini-3.7-flash']);
  assert.match(notice,/Gemini Flash 最新版 → Gemini 3\.7 Flash/);
  assert.match(notice,/現在利用できないモデル/);
});

test('per-minute 429 honors RetryInfo and adds a small safety second',()=>{
  const now=1_800_000_000_000;
  const raw=JSON.stringify({error:{details:[
    {'@type':'type.googleapis.com/google.rpc.QuotaFailure',violations:[{quotaId:'GenerateRequestsPerMinutePerProjectPerModel-FreeTier'}]},
    {'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:'12.5s'},
  ]}});
  const block=quotaBlockFrom429(raw,now);
  assert.equal(block.scope,'minute');
  assert.equal(block.blockedUntil,now+13_500);
});

test('per-day 429 blocks until at least the next Pacific midnight',()=>{
  const now=Date.parse('2026-09-03T05:30:00Z');
  const raw=JSON.stringify({error:{details:[
    {'@type':'type.googleapis.com/google.rpc.QuotaFailure',violations:[{quotaId:'GenerateRequestsPerDayPerProjectPerModel-FreeTier'}]},
    {'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:'30s'},
  ]}});
  const reset=nextPacificQuotaResetMs(now);
  const block=quotaBlockFrom429(raw,now);
  assert.equal(block.scope,'day');
  assert.ok(block.blockedUntil>=reset+2_000);
  assert.equal(new Date(reset).toISOString(),'2026-09-03T07:00:00.000Z');
});
