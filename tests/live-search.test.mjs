import test from 'node:test';
import assert from 'node:assert/strict';
import {liveSearch} from '../.test-dist/live-search.js';
import {UpstreamTimeoutError} from '../.test-dist/timeout.js';

class Socket extends EventTarget {
  closed=false;
  accept(){}
  close(){this.closed=true;}
  emit(data){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(data)}));}
  send(raw){
    const data=JSON.parse(raw);
    if(data.setup){assert.deepEqual(data.setup.tools,[{googleSearch:{}}]);queueMicrotask(()=>this.emit({setupComplete:{}}));}
    else queueMicrotask(()=>{
      this.emit({serverContent:{outputTranscription:{text:'検索結果'},groundingMetadata:{webSearchQueries:['浜松'],groundingChunks:[]}}});
      this.emit({serverContent:{turnComplete:true}});
    });
  }
}
test('Live waits for complete turn and closes the audio session',async(t)=>{
  const socket=new Socket();
  t.mock.method(globalThis,'fetch',async()=>({webSocket:socket,status:101}));
  const result=await liveSearch({GEMINI_API_KEY:'test'},'public conditions',1000);
  assert.equal(result.text,'検索結果');assert.deepEqual(result.metadata.webSearchQueries,['浜松']);assert.equal(socket.closed,true);
});
test('Live connection stalls are bounded even if transport ignores abort',async(t)=>{
  t.mock.method(globalThis,'fetch',async()=>new Promise(()=>{}));
  await assert.rejects(liveSearch({GEMINI_API_KEY:'test'},'public',20),UpstreamTimeoutError);
});
