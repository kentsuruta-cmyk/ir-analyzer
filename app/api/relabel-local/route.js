import Anthropic from "@anthropic-ai/sdk";

export const runtime = "nodejs";
export const maxDuration = 120;

// 安く速いモデルで、資料の冒頭テキストから見出し情報を判定する。
const MODEL = "claude-haiku-4-5";
const CHARS = 1500;

function buildPrompt(items) {
  return (
    "以下は複数のIR資料の冒頭テキストです。各資料について、会社名・決算期・四半期・資料種別を判定してください。判断できない項目は空文字にしてください。\n\n" +
    items.map((i) => `[id: ${i.id}]\n${i.textPrefix}\n---`).join("\n")
  );
}

export async function POST(request) {
  if (process.env.VERCEL) {
    return Response.json(
      { error: "このAPIはローカル実行時のみ動作します。" },
      { status: 501 }
    );
  }
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || !apiKey.startsWith("sk-ant")) {
      return Response.json(
        { error: "APIキーが正しく設定されていません（.env.local の ANTHROPIC_API_KEY）。" },
        { status: 500 }
      );
    }

    const { documents } = await request.json();
    const docs = (documents || []).filter((d) => d && d.id != null && d.text);
    if (docs.length === 0) {
      return Response.json({ error: "対象の資料がありません" }, { status: 400 });
    }

    const items = docs.map((d) => ({
      id: String(d.id),
      textPrefix: (d.text || "").slice(0, CHARS),
    }));

    const anthropic = new Anthropic({ apiKey });
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 3000,
      tools: [
        {
          name: "label_documents",
          description: "各資料の冒頭テキストから、会社名・決算期・四半期・資料種別を判定する。",
          input_schema: {
            type: "object",
            properties: {
              results: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    company: { type: "string", description: "会社名。例: 野村ホールディングス。不明なら空文字" },
                    fiscalPeriod: { type: "string", description: "決算期。例: 2026年3月期。不明なら空文字" },
                    quarter: {
                      type: "string",
                      description: "第1四半期 / 第2四半期 / 第3四半期 / 通期 / 中間期 / 不明 のいずれか",
                    },
                    docType: {
                      type: "string",
                      description:
                        "決算短信 / 決算説明資料 / 有価証券報告書 / 四半期報告書 / 決算補足資料 / 質疑応答 / その他 のいずれか",
                    },
                  },
                  required: ["id", "company", "fiscalPeriod", "quarter", "docType"],
                },
              },
            },
            required: ["results"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "label_documents" },
      messages: [{ role: "user", content: buildPrompt(items) }],
    });

    const toolUse = res.content.find((b) => b.type === "tool_use");
    const results = toolUse?.input?.results || [];

    // ラベル形式: 「決算期 四半期 会社名 種別」（時期を頭に、次に会社名）
    const labels = {};
    for (const r of results) {
      const q = r.quarter && r.quarter !== "不明" ? r.quarter : "";
      const parts = [r.fiscalPeriod, q, r.company, r.docType].map((s) => (s || "").trim()).filter(Boolean);
      if (parts.length) labels[r.id] = parts.join(" ");
    }

    return Response.json({ labels });
  } catch (e) {
    return Response.json({ error: `エラー: ${e.message}` }, { status: 500 });
  }
}
