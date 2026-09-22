import type { Env } from "./types.js";
import { geminiApiKey } from "./gemini-key.js";
import { UpstreamTimeoutError } from "./timeout.js";

export const LIVE_SEARCH_MODEL = "gemini-3.8-live";

// Only public search conditions enter this session. Audio is discarded immediately.
export async function liveSearch(env: Env, prompt: string, timeoutMs: number): Promise<{text:string;metadata:Record<string,unknown>}> {
  const controller = new AbortController();
  let socket: (WebSocket & {accept():void}) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  try {
    return await new Promise((resolve, reject) => {
      const fail = (error: Error) => { if (!settled) { settled=true; reject(error); } };
      timer = setTimeout(() => { controller.abort(); fail(new UpstreamTimeoutError("Live event search",timeoutMs)); }, Math.max(1,timeoutMs));
      const url = new URL("https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent");
      url.searchParams.set("key",geminiApiKey(env));
      void fetch(url, {headers:{Upgrade:"websocket"},signal:controller.signal}).then(response => {
        socket = (response as Response & {webSocket?: WebSocket & {accept():void}}).webSocket;
        if (settled) { if (socket) { socket.accept(); socket.close(1000); } return; }
        if (!socket) { fail(new Error(`Live handshake status=${response.status}`)); return; }
        let text = "";
        let metadata: Record<string,unknown> = {};
        socket.addEventListener("message", event => {
          if (settled) return;
          try {
            const raw = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
            const message = JSON.parse(raw);
            if (message.error) { fail(new Error("Live API rejected request")); return; }
            if (message.setupComplete) socket!.send(JSON.stringify({clientContent:{turns:[{role:"user",parts:[{text:prompt}]}],turnComplete:true}}));
            const content = message.serverContent;
            if (!content) return;
            if (typeof content.outputTranscription?.text === "string") text += content.outputTranscription.text;
            if (text.length > 16000) { fail(new Error("Live text limit")); return; }
            if (content.groundingMetadata) metadata = content.groundingMetadata;
            if (content.interrupted) { fail(new Error("Live turn interrupted")); return; }
            if (content.turnComplete) { settled=true; resolve({text:text.trim(),metadata}); }
          } catch { fail(new Error("Invalid Live response")); }
        });
        socket.addEventListener("error", () => fail(new Error("Live connection error")));
        socket.addEventListener("close", () => fail(new Error("Live closed before completion")));
        socket.accept();
        socket.send(JSON.stringify({setup:{model:`models/${LIVE_SEARCH_MODEL}`,generationConfig:{responseModalities:["AUDIO"]},outputAudioTranscription:{},tools:[{googleSearch:{}}]}}));
      }).catch(() => fail(new Error("Live connection failed")));
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    settled=true;
    controller.abort();
    try { socket?.close(1000); } catch { /* Already closed. */ }
  }
}
