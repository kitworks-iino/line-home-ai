import type { GroupRow, MemberRow, MemoryRow, MessageRow, SummaryRow } from "./types.js";

export function systemInstruction(group: GroupRow, members: MemberRow[]): string {
  const memberText = members.map((m) => `${m.display_name} (user_id=${m.user_id}, role=${m.role})`).join(" / ");
  return [
    "あなたはLINE家族グループに常駐するAIアシスタントです。",
    `参加者: ${memberText}`,
    "発言者を厳密に区別し、誰か一方に迎合せず、必要なら意見の相違を整理してください。",
    "通常は日本語で、結論を先に、必要十分な具体性で答えてください。",
    "提供された会話ログ・要約・長期記憶を事実として扱えますが、矛盾する場合はより新しい明示的な発言を優先してください。",
    "LINEで読みやすいプレーンテキストを使い、Markdown表は避けてください。",
    "日付はAsia/Tokyo（日本時間）で解釈し、「今日」「明日」は現在の依頼の送信日時を基準にしてください。",
    "地域の指定がないお出かけ・イベント相談の対象は静岡県浜松市です。直近の会話で別の地域・日付が明示されていればそれを優先してください。",
    "最新の開催情報・営業時間・料金は、今回取得した検索結果がない限り確認済みと断定しないでください。検索を実行していない場合は検索したと装わず、開催日や出典URLを創作しないでください。",
    "個人情報や家族情報を外部へ共有するよう促さないでください。",
    group.persona ? `この家族固有の追加指示:\n${group.persona}` : "",
  ].filter(Boolean).join("\n");
}

export function conversationPrompt(messages: MessageRow[], summaries: SummaryRow[], memories: MemoryRow[], currentMessageId: string): string {
  const requestedAt = messages.find((m) => m.line_message_id === currentMessageId)?.created_at ?? Date.now();
  const requestTime = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(requestedAt));
  const memoryText = memories.length ? memories.map((m) => `- [${m.id}] (${m.subject_key}/${m.memory_key}) ${m.content}`).join("\n") : "（なし）";
  const summaryText = summaries.length ? summaries.map((s) => `- ${s.summary}`).join("\n") : "（なし）";
  const transcript = messages.map((m) => {
    const body = m.text ?? (m.media_key ? `[${m.type}添付]` : `[${m.type}]`);
    return `[${new Date(m.created_at).toISOString()}] [message_id=${m.line_message_id}] ${m.sender_name}${m.role === "assistant" ? "(AI)" : ""}: ${body}`;
  }).join("\n");
  return `【現在の依頼の送信日時】\n${requestTime}（Asia/Tokyo、日本時間）\n「今日」「明日」などの相対日付はこの日時を基準に解釈してください。\n\n【長期記憶】\n${memoryText}\n\n【過去会話の要約】\n${summaryText}\n\n【直近会話】\n${transcript}\n\n現在の依頼は message_id=${currentMessageId} の発言です。この会話の流れを踏まえて返答してください。`;
}

export function memoryExtractionPrompt(messages: MessageRow[], existing: MemoryRow[], members: MemberRow[]): string {
  const memberMap = members.map((m) => `${m.display_name}=user_id:${m.user_id}`).join("\n");
  const old = existing.length ? existing.map((m) => `- ${m.subject_key}/${m.memory_key}: ${m.content}`).join("\n") : "（なし）";
  const transcript = messages.map((m) => `[message_id=${m.line_message_id}] [user_id=${m.sender_user_id ?? "assistant"}] ${m.sender_name}: ${m.text ?? `[${m.type}]`}`).join("\n");
  return `【人物対応】\n${memberMap}\n\n【既存記憶】\n${old}\n\n【新しい会話】\n${transcript}\n\nこの区間の要約と、永続記憶の変更をJSONで返してください。`;
}
