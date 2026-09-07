import type { Env, LineQueuePayload, LineWebhookBody, QueuePayload } from "./types.js";
import { ensureSchema } from "./schema.js";
import { DEFAULT_IMPLICIT_FOLLOWUP_WINDOW_MS } from "./invocation.js";
import { modelRoute } from "./model-routing.js";
import { processQueuePayload } from "./processor.js";
import { boundedMs } from "./timeout.js";
import { constantTimeEqual } from "./util.js";

async function verifyLineSignature(rawBody:string,signature:string,secret:string):Promise<boolean>{
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const digest=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(rawBody));
  const expected=btoa(String.fromCharCode(...new Uint8Array(digest)));
  return constantTimeEqual(expected,signature);
}

async function webhook(request:Request,env:Env):Promise<Response>{
  const raw=await request.text();
  const signature=request.headers.get("x-line-signature");
  if(!signature||!await verifyLineSignature(raw,signature,env.LINE_CHANNEL_SECRET)) return new Response("invalid signature",{status:401});
  let body:LineWebhookBody;
  try{body=JSON.parse(raw) as LineWebhookBody;}catch{return new Response("invalid json",{status:400});}
  for(const event of body.events??[]){
    const payload:LineQueuePayload={destination:body.destination,event,receivedAt:Date.now()};
    await env.EVENT_QUEUE.send(payload,{contentType:"json"});
  }
  return new Response("OK",{status:200});
}

export default {
  async fetch(request:Request,env:Env):Promise<Response>{
    const url=new URL(request.url);
    if(url.pathname==="/health"){
      const required = {
        LINE_CHANNEL_ID: Boolean(env.LINE_CHANNEL_ID),
        LINE_CHANNEL_SECRET: Boolean(env.LINE_CHANNEL_SECRET),
        GEMINI_API_KEY: Boolean(env.GEMINI_API_KEY),
        SETUP_CODE: Boolean(env.SETUP_CODE),
      };
      let database = true;
      try {
        await ensureSchema(env);
      } catch (error) {
        database = false;
        console.error("health schema initialization failed", error);
      }
      const configured = Object.values(required).every(Boolean);
      const routing = modelRoute(env);
      return Response.json({
        ok: database,
        ready: database && configured,
        service:"line-home-ai",
        model:routing.primary,
        modelRouting:routing,
        version:"1.2.1",
        database,
        queues:{reply:"line-home-ai-events",memory:"line-home-ai-memory",isolated:true},
        latency:{
          modelTimeoutMs:boundedMs(env.GEMINI_MODEL_TIMEOUT_MS,45_000,10_000,90_000),
          normalReplyDeadlineMs:boundedMs(env.GEMINI_REPLY_DEADLINE_MS,90_000,20_000,180_000),
          deepReplyDeadlineMs:boundedMs(env.GEMINI_DEEP_DEADLINE_MS,180_000,30_000,300_000),
          memoryTimeoutMs:boundedMs(env.GEMINI_MEMORY_TIMEOUT_MS,45_000,10_000,120_000),
          lineApiTimeoutMs:boundedMs(env.LINE_API_TIMEOUT_MS,10_000,3_000,30_000),
        },
        invocation:{
          implicitFollowup:true,
          implicitFollowupWindowMs:boundedMs(env.IMPLICIT_FOLLOWUP_WINDOW_MS,DEFAULT_IMPLICIT_FOLLOWUP_WINDOW_MS,30_000,3_600_000),
          rule:"immediate unquoted turn after Home AI",
        },
        configuration:required,
      }, { status: database ? 200 : 503 });
    }
    if(url.pathname==="/webhook"&&request.method==="POST") return webhook(request,env);
    return new Response("Not Found",{status:404});
  },
  async queue(batch:MessageBatch<QueuePayload>,env:Env):Promise<void>{
    console.log(`queue_batch_start queue=${batch.queue} size=${batch.messages.length}`);
    for(const message of batch.messages){
      const started=Date.now();
      try{
        if(batch.queue==="line-home-ai-events" && message.body.kind==="memory"){
          await env.MEMORY_QUEUE.send(message.body,{contentType:"json"});
          message.ack();
          console.log(`queue_message_migrated from=${batch.queue} to=line-home-ai-memory elapsedMs=${Date.now()-started}`);
          continue;
        }
        await processQueuePayload(env,message.body);
        message.ack();
        console.log(`queue_message_complete queue=${batch.queue} attempts=${message.attempts} elapsedMs=${Date.now()-started}`);
      }
      catch(err){
        console.error(`queue_processing_failed queue=${batch.queue} attempts=${message.attempts} elapsedMs=${Date.now()-started}`,err);
        const delaySeconds=Math.min(60,Math.max(2,2 ** Math.min(message.attempts,5)));
        message.retry({delaySeconds});
      }
    }
  }
} satisfies ExportedHandler<Env,QueuePayload>;

export { verifyLineSignature };
