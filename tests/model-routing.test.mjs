import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allModelsExhaustedNotice,
  conversationModels,
  fallbackNotice,
  memoryModel,
  modelDisplayName,
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

test('all-exhausted notice includes attempted model chain',()=>{
  const notice=allModelsExhaustedNotice(['gemini-flash-latest','gemini-3.7-flash']);
  assert.match(notice,/Gemini Flash 最新版 → Gemini 3\.7 Flash/);
});
