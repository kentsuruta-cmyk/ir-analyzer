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
                    fiscalPeriod: {
                      type: "string",
                      description: "決算期。例: 2026年3月期。決算に紐づかない資料（適時開示等）は空文字",
                    },
                    date: {
                      type: "string",
                      description:
                        "決算期が無い資料の日付。例: 2026年4月24日。決算期がある場合は空文字でよい",
                    },
                    quarter: {
                      type: "string",
                      description: "第1四半期 / 第2四半期 / 第3四半期 / 通期 / 中間期 / 不明 のいずれか",
                    },
                    docType: {
                      type: "string",
                      description:
                        "決算短信 / 決算説明資料 / 有価証券報告書 / 四半期報告書 / 決算補足資料 / 質疑応答 / 適時開示 / その他 のいずれか",
                    },
                  },
                  required: ["id", "fiscalPeriod", "date", "quarter", "docType"],
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

    // ラベル形式: 「いつ（決算期 or 日付）＋四半期があれば＋種別」。
    // 会社名は資料棚が1社単位なので省略。「いつの資料か」を先頭に。
    // ラベルに加え、種別・決算期・四半期の構造化フィールドも返す（全自動の資料選別で使う）。
    const labels = {};
    const fields = {};
    for (const r of results) {
      const fiscalYear = (r.fiscalPeriod || "").trim();
      const when = fiscalYear || (r.date || "").trim();
      const q = r.quarter && r.quarter !== "不明" ? r.quarter.trim() : "";
      const parts = [when, q, (r.docType || "").trim()].filter(Boolean);
      if (parts.length) labels[r.id] = parts.join(" ");
      fields[r.id] = { docType: (r.docType || "").trim(), fiscalYear, quarter: q };
    }

    return Response.json({ labels, fields });
  } catch (e) {
    return Response.json({ error: `エラー: ${e.message}` }, { status: 500 });
  }
}
