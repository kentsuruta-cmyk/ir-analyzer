import Anthropic from "@anthropic-ai/sdk";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_TOTAL_CHARS = 150000;

const RULES = `あなたは株式投資の分析アシスタントです。ユーザーから提供された資料だけを根拠に回答します。

【絶対に守るルール】
1. 提供された資料に書かれていることだけを根拠にしてください。あなたの一般知識や記憶にある企業情報は一切使わないでください。
2. 数値・事実を述べるときは、必ず次の形式で出典と原文引用を添えてください。
   例）営業利益は前年同期比12.3%増の1,250百万円でした。
       〔出典: 2026年3月期 決算短信〕
       〔原文: 営業利益 1,250百万円（前年同期比 12.3％増）〕
3. 原文をそのまま抜き出せない情報は、述べてはいけません。
4. 資料に書かれていないことを聞かれたら、推測せず「提供された資料には記載がありません」と明記してください。何が不足しているかを一言添えてください。
5. 資料から計算して導いた数値は、必ず「（資料の数値から算出）」と明記し、計算に使った元の数値も示してください。
6. 資料の内容と、あなたの解釈・所見は明確に分けてください。解釈には「【所見】」という見出しを付けてください。
7. 確度が低い場合は、その旨を正直に述べてください。断定を避けることより、正確であることを優先してください。

【回答スタイル】
- 日本語で、結論から述べてください。
- 見出しと箇条書きで読みやすく整理してください。
- 冗長な前置きは不要です。`;

export async function POST(request) {
  try {
    const { documents, messages } = await request.json();

    if (!process.env.ANTHROPIC_API_KEY) {
      return Response.json(
        { error: "APIキーが設定されていません" },
        { status: 500 }
      );
    }

    if (!documents || documents.length === 0) {
      return Response.json(
        { error: "参照する資料が選択されていません" },
        { status: 400 }
      );
    }

    let docBlock = "";
    const included = [];
    for (const doc of documents) {
      const block = `\n\n===== 資料: ${doc.label} =====\n出典URL: ${doc.url}\n\n${doc.text}\n===== 資料ここまで =====`;
      if (docBlock.length + block.length > MAX_TOTAL_CHARS) break;
      docBlock += block;
      included.push(doc.label);
    }

    const system = `${RULES}\n\n【参照可能な資料は以下がすべてです】${docBlock}`;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

 const response = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 4000,
      system,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    const answer = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    return Response.json({ answer, includedCount: included.length });
  } catch (e) {
    return Response.json({ error: `エラー: ${e.message}` }, { status: 500 });
  }
}
