import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

export const METRICS_MODEL = "claude-opus-5";

// 画面に出す指標。Kenが見たいのは「売上・営業利益・経常利益が伸びているか」なので
// この4本に固定する。資料に無いものは行ごと落とす。
export const METRIC_NAMES = ["売上高", "営業利益", "経常利益", "親会社株主に帰属する当期純利益"];

// 表をLLMにMarkdownで書かせると崩れる余地が残るので、構造化出力で受け取り、
// 描画側（React）で罫線付きの表を組み立てる。
const Cell = z.object({
  period_label: z.string(),          // periods[].label と一致させる
  display: z.string(),               // 原文どおりの表記（例 "12,500百万円"）。無ければ ""
  numeric_million_yen: z.number().nullable(), // 百万円換算。増減判定と色分けに使う。読めなければ null
  yoy_text: z.string(),              // 原文に書かれている前年同期比。書かれていなければ ""
  source: z.string(),                // 〔資料名 P.x〕
});

const MetricsSchema = z.object({
  fiscal_year_end_month: z.number().int().nullable(),  // 決算月（3月期なら3）
  periods: z.array(
    z.object({
      label: z.string(),             // "2026年3月期" / "2027年3月期(会社予想)" / "2027年3月期 1Q"
      kind: z.enum(["通期実績", "通期会社予想", "四半期実績", "四半期累計"]),
      is_forecast: z.boolean(),
      order: z.number().int(),       // 古い→新しい の並び順
    })
  ),
  rows: z.array(
    z.object({
      metric: z.string(),
      cells: z.array(Cell),
    })
  ),
  // 「企業側がその数字をどう思っているか」。Kenが明示的に求めた部分なので、
  // 会社自身の言葉（原文引用）だけを入れ、こちらの解釈は入れない。
  company_view: z.array(
    z.object({
      topic: z.string(),                                   // 何についての見方か
      stance: z.enum(["強気", "慎重", "中立", "不明"]),
      quote: z.string(),                                   // 原文引用
      source: z.string(),
    })
  ),
  forecast_revision: z.object({
    has_revision: z.boolean(),
    direction: z.enum(["上方修正", "下方修正", "据え置き", "記載なし"]),
    quote: z.string(),
    source: z.string(),
  }),
  notes: z.array(z.string()),        // 判読不可・欠測などの但し書き
});

const SYSTEM = `あなたはIR資料の要約から、業績数値を機械可読な形で正確に取り出す担当です。

【絶対に守るルール】
1. 与えられた要約に実際に書かれている数値だけを使う。推測・記憶・自分の計算による数値は入れない。
2. display は原文の表記をそのまま入れる（単位・カンマを含む）。要約に無い期・指標は、その cell 自体を作らない。
3. numeric_million_yen は「百万円に換算した数値」。単位換算（億円→百万円は×100、千円→百万円は÷1000）だけは行ってよい。
   原文が判読不可・記載なしの場合は null にする。マイナスは負数で入れる。
4. yoy_text は原文に書かれている前年同期比のみ。書かれていなければ空文字。自分で計算しない。
5. source は要約に付いている出典をそのまま写す（例 〔2026年3月期3Q決算短信 P.3〕）。
6. periods は古い順に order を振る。会社予想の期は is_forecast=true にする。
7. company_view は会社自身が資料に書いた見方だけ。quote は原文のまま。あなたの評価・解釈は書かない。
   会社の見方が要約に無ければ空配列にする。
8. metric は次の表記に正規化する: 売上高 / 営業利益 / 経常利益 / 親会社株主に帰属する当期純利益。
   これ以外の指標（営業収益、売上収益など）は、意味が対応するものに寄せてよいが、
   対応が無ければその行を作らない。`;

// 各資料の要約テキスト（原文引用・出典ページ入り）から業績数値を構造化して取り出す。
// summaries: [{ label, text }]
export async function extractMetrics({ summaries, apiKey }) {
  const anthropic = new Anthropic({ apiKey });
  const joined = summaries
    .map((s, i) => `===== 資料${i + 1}: ${s.label} =====\n${s.text}`)
    .join("\n\n");

  const res = await anthropic.messages.parse({
    model: METRICS_MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: zodOutputFormat(MetricsSchema, "ir_metrics") },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `以下は各期のIR資料をそれぞれ忠実に要約したものです。ここから業績数値を取り出してください。
売上高・営業利益・経常利益・親会社株主に帰属する当期純利益の推移と、進行期の会社予想を漏らさないでください。

${joined}`,
      },
    ],
  });

  if (res.stop_reason === "refusal") throw new Error("数値の抽出が拒否されました");
  if (!res.parsed_output) throw new Error("数値をスキーマどおりに取り出せませんでした");
  return normalize(res.parsed_output);
}

// 表示側が扱いやすい形に整える（期の並び替え、指標の並び順固定、空行の除去）
function normalize(data) {
  const periods = [...(data.periods || [])].sort((a, b) => a.order - b.order);
  const known = new Set(periods.map((p) => p.label));

  const rows = METRIC_NAMES.map((name) => {
    const row = (data.rows || []).find((r) => r.metric === name);
    if (!row) return null;
    const cells = (row.cells || []).filter((c) => known.has(c.period_label) && c.display);
    if (cells.length === 0) return null;
    return { metric: name, cells };
  }).filter(Boolean);

  return { ...data, periods, rows };
}

export { MetricsSchema };
