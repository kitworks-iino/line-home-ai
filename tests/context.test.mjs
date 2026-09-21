import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationPrompt } from '../.test-dist/context.js';

test('relative dates use the current message timestamp in JST, including midnight and queued follow-ups', () => {
  const messages = [
    {line_message_id:'previous', created_at:Date.parse('2026-09-21T14:59:00Z'), sender_name:'家族', role:'user', type:'text', text:'明日のイベントは？'},
    {line_message_id:'current', created_at:Date.parse('2026-09-21T15:01:00Z'), sender_name:'家族', role:'user', type:'text', text:'今日は？'},
    {line_message_id:'later', created_at:Date.parse('2026-09-22T15:01:00Z'), sender_name:'家族', role:'user', type:'text', text:'別の発言'},
  ];
  const prompt = conversationPrompt(messages, [], [], 'current');
  assert.match(prompt, /2026\/09\/22.*00:01/);
  assert.match(prompt, /Asia\/Tokyo/);
  assert.match(prompt, /現在の依頼は message_id=current/);
});
