import Anthropic from "@anthropic-ai/sdk";

const RE_FISCAL_YEAR = /((?:19|20)\d{2})年\s*(\d{1,2})\s*月期/;
const RE_TERM = /第\s*(\d{1,3})\s*期/;
// 「2025年度」表記。「2025年3月期」と書かないIRサイトが多く、これを読み落とすと
// 決算期が不明のまま＝古い資料の足切りが効かなくなる。
const RE_NENDO = /((?:19|20)\d{2})\s*年度/;
const RE_QUARTER = /第\s*([一二三四五六七八九1-9])\s*(?:四半期|半期)/;
const RE_FULL_YEAR = /通期/;
const RE_KESSAN_TANSHIN = /短信/;
const RE_YUHO = /有価証券報告書/;
const RE_QUARTERLY_REPORT = /四半期報告書/;
const RE_HANKI_REPORT = /半期報告書/;
const RE_SETSUMEI_SHIRYOU = /(決算説明|説明資料|IR説明会|決算補足)/;
// 説明会の質疑応答・議事録。説明会資料とは別物として扱う（投資判断の材料として
// 需要が高く、種別を分けないと「その他」に落ちて取りこぼす）。
const RE_QA = /(質疑応答|質疑|Q\s*&\s*A|Ｑ\s*＆\s*Ａ|Q＆A|QandA|questions?\s*(and|&)\s*answers?|議事録|想定問答|説明会要旨|主な質問|ご質問と回答|質問と回答|いただいたご質問)/i;
// 説明会の書き起こし（全文）。質疑応答とは別に、経営陣が自分の言葉で先行きを語る
// 部分が入るため、投資判断の材料として独立した種別で拾う。
const RE_TRANSCRIPT = /(書き?起こし|文字起こし|トランスクリプト|transcript|説明会\s*全文|説明会\s*(の)?内容|スクリプト|ログミー)/i;
// 中期経営計画。決算期の表記が無いことが多いので、種別だけで拾えるようにする。
const RE_CHUKEI = /(中期経営計画|中期経営方針|中期計画|中期戦略|中計|mid[-\s]?term|medium[-\s]?term)/i;
// 株主通信（「第64期 業績のご報告」など）。決算説明資料と語が似ているが別物で、
// 標準セットには入れない。説明資料より先に判定する。
const RE_KABUNUSHI = /(株主通信|業績のご報告|事業報告書|アニュアルレポート|統合報告書)/;
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
  // 質疑応答は「決算説明会 質疑応答要旨」のように説明会資料と同じ語を含むことがあるので、
  // 説明資料より先に判定する。
  if (RE_QA.test(text)) {
    docType = "質疑応答";
  } else if (RE_TRANSCRIPT.test(text)) {
    docType = "説明会書き起こし";
  } else if (RE_KABUNUSHI.test(text)) {
    docType = "株主通信";
  } else if (RE_CHUKEI.test(text)) {
    // 「中期経営計画説明資料」は決算説明資料より中計として扱いたいので、
    // RE_SETSUMEI_SHIRYOU より先に判定する。
    docType = "中期経営計画";
  } else if (RE_KESSAN_TANSHIN.test(text)) {
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
    // 「2025年度」表記。決算期（2026年3月期）より1年ずれるが、資料の新旧を
    // 比べるには十分。表記はラベルどおり残す。
    const nendoMatch = text.match(RE_NENDO);
    if (nendoMatch) {
      fiscalYear = `${nendoMatch[1]}年度`;
    } else {
      // 有価証券報告書などは「20XX年X月期」ではなく「第XX期」で表記されることが多い
      const termMatch = text.match(RE_TERM);
      if (termMatch) {
        fiscalYear = `第${termMatch[1]}期`;
      }
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

  // 中期経営計画と説明会書き起こしは決算期が書かれていないことが普通なので、
  // 決算期が無くても種別が確定していれば high とみなす（Claudeへの再問い合わせを省く）。
  const typeOnlyOk = docType === "中期経営計画" || docType === "説明会書き起こし";
  const confidence = docType && (fiscalYear || typeOnlyOk) ? "high" : "low";

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
                      "質疑応答",
                      "説明会書き起こし",
                      "中期経営計画",
                      "株主通信",
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
