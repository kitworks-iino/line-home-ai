import test from 'node:test';
import assert from 'node:assert/strict';
import { isImplicitAssistantFollowup, mentionsAnotherUser } from '../.test-dist/invocation.js';
import { hasNaturalInvocation, stripNaturalInvocation } from '../.test-dist/util.js';

const now=1_800_000_000_000;

test('immediate unquoted turn after Home AI is an implicit invocation',()=>{
  assert.equal(isImplicitAssistantFollowup({role:'assistant',created_at:now-30_000,unsent:0},now,null,600_000),true);
});

test('old Home AI message does not make later household chat an invocation',()=>{
  assert.equal(isImplicitAssistantFollowup({role:'assistant',created_at:now-600_001,unsent:0},now,null,600_000),false);
});

test('human-to-human turn does not implicitly invoke Home AI',()=>{
  assert.equal(isImplicitAssistantFollowup({role:'user',created_at:now-1_000,unsent:0},now,null,600_000),false);
});

test('a LINE quote is handled explicitly rather than by adjacency inference',()=>{
  assert.equal(isImplicitAssistantFollowup({role:'assistant',created_at:now-1_000,unsent:0},now,'quoted-id',600_000),false);
});

test('mentioning another LINE user suppresses adjacency inference',()=>{
  const message={type:'text',id:'m1',text:'そっちはどう？',mention:{mentionees:[{type:'user',index:0,length:3,userId:'U2',isSelf:false}]}};
  assert.equal(mentionsAnotherUser(message),true);
});

test('typed HOME-AI invocation works without an @ mention',()=>{
  assert.equal(hasNaturalInvocation('HOME-AI おい'),true);
  assert.equal(stripNaturalInvocation('HOME-AI おい'),'おい');
});
