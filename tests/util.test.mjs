import test from 'node:test';
import assert from 'node:assert/strict';
import { hasNaturalInvocation, parseCommand, splitLineText, stripNaturalInvocation } from '../.test-dist/util.js';

test('explicit invocation detection',()=>{
  assert.equal(hasNaturalInvocation('GPT、これどう思う？'),true);
  assert.equal(hasNaturalInvocation('AI: 教えて'),true);
  assert.equal(hasNaturalInvocation(' home ai 相談'),true);
  assert.equal(hasNaturalInvocation('GPTについて話そう'),false);
  assert.equal(hasNaturalInvocation('GeminiとGPTを比較したい'),false);
  assert.equal(stripNaturalInvocation('GPT、これどう思う？'),'これどう思う？');
});

test('slash command parsing',()=>{
  assert.deepEqual(parseCommand('/thinking high'),{name:'thinking',args:'high'});
  assert.equal(parseCommand('hello /help'),null);
});

test('LINE text chunks stay bounded',()=>{
  const p=splitLineText('a'.repeat(10000),4500);
  assert.equal(p.length,3);
  assert.equal(p.every(x=>x.length<=4500),true);
});
