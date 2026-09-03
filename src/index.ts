import type { Env, LineWebhookBody, QueuePayload } from "./types.js";
import { ensureSchema } from "./schema.js";
import { processQueuePayload } from "./processor.js";
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
    const payload:QueuePayload={destination:body.destination,event,receivedAt:Date.now()};
    await env.EVENT_QUEUE.send(payload,{contentType:"json"});
  }
  return new Response("OK",{status:200});
}

export default {
  async fetch(request:Request,env:Env):Promise<Response>{
    const url=new URL(request.url);
    if(url.pathname==="/health"){
      await ensureSchema(env);
      const required = {
        LINE_CHANNEL_ID: Boolean(env.LINE_CHANNEL_ID),
        LINE_CHANNEL_SECRET: Boolean(env.LINE_CHANNEL_SECRET),
        GEMINI_API_KEY: Boolean(env.GEMINI_API_KEY),
        SETUP_CODE: Boolean(env.SETUP_CODE),
      };
      return Response.json({ok:true,ready:Object.values(required).every(Boolean),service:"line-home-ai",model:env.GEMINI_MODEL,version:"1.0.0",configuration:required});
    }
    if(url.pathname==="/webhook"&&request.method==="POST") return webhook(request,env);
    return new Response("Not Found",{status:404});
  },
  async queue(batch:MessageBatch<QueuePayload>,env:Env):Promise<void>{
    for(const message of batch.messages){
      try{await processQueuePayload(env,message.body);message.ack();}
      catch(err){
        console.error("queue processing failed",err);
        const delaySeconds=Math.min(60,Math.max(2,2 ** Math.min(message.attempts,5)));
        message.retry({delaySeconds});
      }
    }
  }
} satisfies ExportedHandler<Env,QueuePayload>;

export { verifyLineSignature };
