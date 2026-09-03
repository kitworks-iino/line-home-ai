import type { Env, GroupRow, MemberRow, ThinkingLevel } from "./types.js";
import { approveJoin, createJoinRequest, deactivateMemory, getBoundGroup, getGroup, listMembers, listMemories, rejectJoin, setPersona, setThinking, stats, upsertMemory } from "./db.js";
import { normalizeThinking } from "./util.js";

export interface CommandContext {
  env: Env;
  groupId: string;
  userId: string;
  displayName: string;
  member: MemberRow | null;
  group: GroupRow | null;
}

const HELP = `Home AI コマンド
/help — この一覧
/join — 家族メンバー参加申請
/approve CODE — 管理者が参加承認
/reject CODE — 管理者が申請拒否
/members — 登録メンバー
/memories [検索語] — 長期記憶を確認
/remember 内容 — 内容を明示的に家族記憶へ追加
/forget ID — 記憶を無効化
/persona [内容|reset] — AIの家族固有指示（管理者）
/thinking low|medium|high — 通常の推論強度（管理者）
/status — 稼働状態・保存件数
/delete-data DELETE ALL — 全データ削除（管理者）

通常会話では @Home AI、または文頭の「GPT、」「AI、」で呼び出せます。AIの直前の返信を引用して返信した場合も会話を継続します。難しい質問は文頭に /deep と付けられます。`;

function requireMember(ctx: CommandContext): MemberRow | string {
  return ctx.member ?? "この操作には承認済みメンバー登録が必要です。`/join` を送ってください。";
}
function requireAdmin(ctx: CommandContext): MemberRow | string {
  const m = requireMember(ctx); if (typeof m === "string") return m;
  return m.role === "admin" ? m : "この操作は管理者のみ実行できます。";
}

export async function runCommand(ctx: CommandContext, name: string, args: string): Promise<{text:string;deleteAll?:boolean;deepPrompt?:string}> {
  const {env,groupId,userId,displayName} = ctx;
  switch(name) {
    case "help": return {text:HELP};
    case "join": {
      if (ctx.member) return {text:"すでに承認済みメンバーです。"};
      if (!ctx.group) return {text:"このグループはまだセットアップされていません。管理者が `/setup <SETUP_CODE>` を実行してください。"};
      const code = await createJoinRequest(env,groupId,userId,displayName);
      return {text:`参加申請を作成しました。管理者はこのグループで \`/approve ${code}\` を送ってください。申請は7日で失効します。`};
    }
    case "approve": {
      const admin = requireAdmin(ctx); if(typeof admin==="string") return {text:admin};
      if(!args) return {text:"使い方: /approve CODE"};
      try {
        const member = await approveJoin(env,groupId,args.trim().toUpperCase());
        return {text:member ? `${member.display_name} を家族メンバーとして承認しました。` : "有効な参加申請が見つかりません。コードまたは有効期限を確認してください。"};
      } catch(e) { return {text:e instanceof Error?e.message:"承認に失敗しました。"}; }
    }
    case "reject": {
      const admin=requireAdmin(ctx); if(typeof admin==="string") return {text:admin};
      if(!args) return {text:"使い方: /reject CODE"};
      const rejected=await rejectJoin(env,groupId,args.trim().toUpperCase()); return {text:rejected?"参加申請を拒否しました。":"有効な参加申請が見つかりません。"};
    }
    case "members": {
      const m=requireMember(ctx); if(typeof m==="string") return {text:m};
      const members=await listMembers(env,groupId); return {text:`登録メンバー\n${members.map(x=>`- ${x.display_name} (${x.role})`).join("\n")}`};
    }
    case "memories": {
      const m=requireMember(ctx); if(typeof m==="string") return {text:m};
      const rows=await listMemories(env,groupId,args,30);
      return {text:rows.length?`長期記憶\n${rows.map(x=>`[${x.id}] ${x.content}`).join("\n")}`:"該当する長期記憶はありません。"};
    }
    case "remember": {
      const m=requireMember(ctx); if(typeof m==="string") return {text:m};
      if(!args) return {text:"使い方: /remember 覚えておいてほしい内容"};
      const key=`manual.${crypto.randomUUID()}`;
      const id=await upsertMemory(env,groupId,"family",key,args,1,true,[]);
      return {text:`記憶しました。[${id}] ${args}`};
    }
    case "forget": {
      const m=requireMember(ctx); if(typeof m==="string") return {text:m};
      const id=Number.parseInt(args,10); if(!Number.isFinite(id)) return {text:"使い方: /forget 記憶ID"};
      const forgotten=await deactivateMemory(env,groupId,id); return {text:forgotten?`記憶ID ${id} を無効化しました。`:`有効な記憶ID ${id} は見つかりません。`};
    }
    case "persona": {
      const admin=requireAdmin(ctx); if(typeof admin==="string") return {text:admin};
      if(!ctx.group) return {text:"グループ設定がありません。"};
      if(!args) return {text:`現在の追加指示:\n${ctx.group.persona ?? "（未設定）"}`};
      if(args.toLowerCase()==="reset") { await setPersona(env,groupId,null); return {text:"家族固有の追加指示をリセットしました。"}; }
      if(args.length>4000) return {text:"追加指示は4000文字以内にしてください。"};
      await setPersona(env,groupId,args); return {text:"家族固有の追加指示を更新しました。"};
    }
    case "thinking": {
      const admin=requireAdmin(ctx); if(typeof admin==="string") return {text:admin};
      if(!["low","medium","high"].includes(args)) return {text:"使い方: /thinking low|medium|high"};
      const level=normalizeThinking(args) as ThinkingLevel; await setThinking(env,groupId,level); return {text:`通常の推論強度を ${level} に設定しました。`};
    }
    case "status": {
      const m=requireMember(ctx); if(typeof m==="string") return {text:m};
      const s=await stats(env,groupId); const members=await listMembers(env,groupId); const group=await getGroup(env,groupId);
      return {text:`Home AI 稼働中\nモデル: ${env.GEMINI_MODEL}\nThinking: ${group?.thinking_level ?? env.DEFAULT_THINKING_LEVEL}\n登録メンバー: ${members.length}/2\n保存メッセージ: ${s.messages}\n有効な長期記憶: ${s.memories}\n要約セグメント: ${s.summaries}`};
    }
    case "delete-data": {
      const admin=requireAdmin(ctx); if(typeof admin==="string") return {text:admin};
      if(args!=="DELETE ALL") return {text:"全データを削除する場合のみ、正確に `/delete-data DELETE ALL` と送ってください。削除後は復元できません。"};
      return {text:"このグループに保存した会話・要約・記憶・メディア・メンバー設定を削除しました。再利用する場合は /setup からやり直してください。",deleteAll:true};
    }
    case "deep": {
      const m=requireMember(ctx); if(typeof m==="string") return {text:m};
      if(!args) return {text:"使い方: /deep 質問内容"};
      return {text:"",deepPrompt:args};
    }
    case "setup": {
      const bound=await getBoundGroup(env);
      if(bound) return {text:bound===groupId?"このグループはセットアップ済みです。":"このWorkerはすでに別のグループへ一度だけバインドされています。"};
      return {text:"__SETUP__"};
    }
    default: return {text:`不明なコマンドです。\n\n${HELP}`};
  }
}
