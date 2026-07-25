import Anthropic from "@anthropic-ai/sdk";

const RE_FISCAL_YEAR = /((?:19|20)\d{2})年\s*(\d{1,2})\s*月期/;
const RE_TERM = /第\s*(\d{1,3})\s*期/;
const RE_QUARTER = /第\s*([一二三四五六七八九1-9])\s*(?:四半期|半期)/;
const RE_FULL_YEAR = /通期/;
const RE_KESSAN_TANSHIN = /短信/;
const RE_YUHO = /有価証券報告書/;
const RE_QUARTERLY_REPORT = /四半期報告書/;
const RE_HANKI_REPORT = /半期報告書/;
const RE_SETSUMEI_SHIRYOU = /(決算説明|説明資料|IR説明会|決算補足)/;
const RE_CORRECTION = /(訂正|修正)/;

const KANJI_DIGITS = { 一: "1", 二: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9" };

// 全角数字・漢数字を半角数字に正規化してから正規表現を適用する
// （IRサイトのラベルは全角と半角が混在するため）
function toHalfWidth(text) {
  return text.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

function normalizeDigit(ch) {
  return KANJI_DIGITS[ch] || ch;
}

// ラベルテキストだけから決定的に分類する。LLMを使わずに済ませることが目的。
export function classifyFromLabel(label) {
  const rawText = (label || "").trim();
  const text = toHalfWidth(rawText);

  let docType = null;
  if (RE_KESSAN_TANSHIN.test(text)) {
    docType = "決算短信";
  } else if (RE_YUHO.test(text)) {
    docType = "有価証券報告書";
  } else if (RE_QUARTERLY_REPORT.test(text)) {
    docType = "四半期報告書";
  } else if (RE_HANKI_REPORT.test(text)) {
    docType = "半期報告書";
  } else if (RE_SETSUMEI_SHIRYOU.test(text)) {
    docType = "決算説明資料";
  }
  if (docType && RE_CORRECTION.test(text)) {
    docType = `訂正${docType}`;
  }

  let fiscalYear = null;
  const fyMatch = text.match(RE_FISCAL_YEAR);
  if (fyMatch) {
    fiscalYear = `${fyMatch[1]}年${fyMatch[2]}月期`;
  } else {
    // 有価証券報告書などは「20XX年X月期」ではなく「第XX期」で表記されることが多い
    const termMatch = text.match(RE_TERM);
    if (termMatch) {
      fiscalYear = `第${termMatch[1]}期`;
    }
  }

  let quarter = null;
  if (RE_FULL_YEAR.test(text)) {
    quarter = "通期";
  } else {
    const qMatch = text.match(RE_QUARTER);
    if (qMatch) {
      quarter = `第${normalizeDigit(qMatch[1])}四半期`;
    }
  }
  if (!quarter && docType && fiscalYear && docType !== "半期報告書") {
    // 四半期表記が無いことは通期決算では一般的なので、他が確定していれば通期扱いにする。
    // ただし半期報告書は中間期の書類なので通期を付けない。
    quarter = "通期";
  }

  const confidence = docType && fiscalYear ? "high" : "low";

  return { docType, fiscalYear, quarter, confidence };
}

function buildBatchPrompt(items) {
  const blocks = items.map(
    (item) =>
      `[${item.tempId}]\nラベル: ${item.label}\n本文抜粋:\n${item.textPrefix || "(本文なし)"}\n---`
  );
  return `次のIR資料それぞれについて、資料種別・決算期・四半期を判定してください。
与えられたラベルと本文抜粋だけを根拠にしてください。わからない場合は無理に推測せず「不明」としてください。

${blocks.join("\n\n")}`;
}

// 低確信度の項目だけをまとめて1回のリクエストで分類する（トークン節約のため個別呼び出しはしない）
export async function classifyBatchWithClaude(items) {
  if (!items || items.length === 0) return [];
  if (!process.env.ANTHROPIC_API_KEY) {
    return items.map((item) => ({
      tempId: item.tempId,
      docType: "不明",
      fiscalYear: "不明",
      quarter: "不明",
    }));
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 1500,
    tools: [
      {
        name: "classify_documents",
        description: "Classify each IR document by type, fiscal year, and quarter.",
        input_schema: {
          type: "object",
          properties: {
            results: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  tempId: { type: "string" },
                  docType: {
                    type: "string",
                    enum: [
                      "決算短信",
                      "決算説明資料",
                      "有価証券報告書",
                      "四半期報告書",
                      "半期報告書",
                      "不明",
                    ],
                  },
                  fiscalYear: { type: "string" },
                  quarter: { type: "string" },
                },
                required: ["tempId", "docType", "fiscalYear", "quarter"],
              },
            },
          },
          required: ["results"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "classify_documents" },
    messages: [{ role: "user", content: buildBatchPrompt(items) }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  return toolUse?.input?.results || [];
}
