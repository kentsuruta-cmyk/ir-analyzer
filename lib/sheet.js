import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

export const SHEET_MODEL = "claude-opus-5";

// 判断シート＝投資するかどうかを決めるときに先に見たい点を、1行ずつ並べたもの。
// 分析レポートは長く、読まないと結論の根拠が分からない。そこで「見るべき点」を固定の6行にし、
// それぞれ ○△× と根拠1つを冒頭に出す。新しい判断はここでは作らず、
// すでにある分析・事実サマリー・業績表から拾って並べ直すだけにする。
// （7行目の「株価の位置」は J-Quants の数字から計算するので、モデルには書かせない。lib/valuation.js）
export const SHEET_ITEMS = [
  { key: "tailwind", label: "世の中の追い風", hint: "業界・市況がこの会社に追い風か逆風か。分析の「市況」や外部情報の記述から拾う。外部情報を使っていない分析なら「不明」。" },
  { key: "customers", label: "得意先・需要先", hint: "主要な販売先や最終需要先がどこで、その先が好調かどうか。社名が資料に出ていれば社名を書く。得意先の状態を示す記述が無ければ「不明」。" },
  { key: "momentum", label: "業績の勢い", hint: "売上・利益の前年同期比（YoY）と、直前の四半期との比較（QoQ）。QoQは四半期単独の数字が資料にあるときだけ書く。会社予想の修正があれば触れる。" },
  { key: "capex", label: "増産・投資", hint: "設備投資・増産・研究開発・M&Aなど、先の成長のための投資をしているか。金額や時期が資料にあれば入れる。" },
  { key: "finance", label: "財務の余力", hint: "自己資本比率・手元資金・有利子負債・営業キャッシュフローから、投資や不況に耐える余力があるか。" },
  { key: "peers", label: "同業・同規模との比較", hint: "同業の中での順位や位置。分析の「数字で見た位置」から、強い項目と弱い項目を1つずつ。同業比較のデータが無ければ「不明」。" },
];

const SheetSchema = z.object({
  headline: z.string(), // 全体を一言で（60字以内）。売買の推奨は書かない
  items: z.array(
    z.object({
      key: z.enum(SHEET_ITEMS.map((x) => x.key)),
      mark: z.enum(["○", "△", "×", "不明"]),
      point: z.string(),    // 結論を一言（40字以内）
      evidence: z.string(), // 根拠。数字を入れて1〜2文
      source_kind: z.enum(["会社資料", "外部情報", "同業データ", "なし"]),
      source: z.string(),   // 〔資料名 P.x〕や媒体名。無ければ ""
    })
  ),
  // 資料に社名が出ている得意先。あとで各社の決算を J-Quants から取りに行く（lib/customers.js）
  customers: z.array(
    z.object({
      name: z.string(),   // 会社名（正式名に近い形。「㈱」「グループ」などは付けない）
      note: z.string(),   // どういう取引先か（例：「売上の23.4%を占める主要販売先」）
      source: z.string(), // 〔資料名 P.x〕
    })
  ),
});

const SYSTEM = `あなたは、すでに書かれた株式の分析レポートと、その元になった事実サマリーから、
投資判断の前に確認する点を一覧表に整理する担当です。

【絶対に守ること】
1. 新しい事実・数字・見立てを作らない。渡された「分析」「事実サマリー」「業績表」に書かれていることだけを使う。
2. 材料が無い項目は mark を「不明」にし、point に何が無いのかを書く（例：「得意先の業績は資料に記載なし」）。
   無理に ○△× を付けない。
3. mark の意味：○＝投資にとってプラスの材料、△＝強弱が混ざる・中立、×＝マイナスの材料、不明＝材料が無い。
4. point は結論を一言（40字以内）。evidence は根拠を数字入りで、200字以内。
   数字は原文の表記のまま引用する。
5. source には、その根拠が書かれていた資料名（〔資料名 P.x〕）や媒体名を入れる。
   source_kind は、会社が出した資料なら「会社資料」、報道・業界統計・他社の開示なら「外部情報」、
   同業比較の表なら「同業データ」。
6. 「買い」「売り」「投資すべき」といった売買の推奨は書かない。株価の割安・割高にも触れない（別に計算して出す）。
7. items は指定された6項目を、指定された順番で、ちょうど1つずつ出す。
8. headline は全体像を一言で（60字以内）。どの項目が強く、どこが弱い・不明かが分かる形にする。
9. customers には、この会社の**販売先（製品・サービスを買ってくれる会社）として資料や分析に社名が出ている会社**だけを
   最大6社まで入れる。有価証券報告書の「主要な販売先」、説明資料や質疑応答に出てくる納入先・顧客が対象。
   競合・仕入先・子会社・提携先は入れない。「大手半導体メーカー」のように社名が無いものも入れない。
   社名が1つも出ていなければ空の配列にする。記憶で補わない。`;

// analysis: 分析Markdown / summaries: [{label,text}] / metrics: 業績表のJSON（無くてもよい）
export async function extractSheet({ analysis, summaries, metrics, apiKey }) {
  const anthropic = new Anthropic({ apiKey });

  const MAX = 120000;
  let joined = "";
  for (const s of summaries || []) {
    const chunk = `\n\n===== 事実サマリー: ${s.label} =====\n${s.text}`;
    if (joined.length + chunk.length > MAX) break;
    joined += chunk;
  }

  // 業績表は「期・指標・表記・前年同期比」だけに絞って渡す（QoQ/YoYを読み違えないための補助）
  let metricsText = "";
  if (metrics?.rows?.length) {
    const kind = new Map((metrics.periods || []).map((p) => [p.label, `${p.kind}${p.is_cumulative ? "・累計" : "・単独"}`]));
    metricsText = metrics.rows
      .map((r) => `${r.metric}: ` + r.cells.map((c) => `${c.period_label}[${kind.get(c.period_label) || ""}] ${c.display}${c.yoy_text ? `（前年同期比 ${c.yoy_text}）` : ""}`).join(" / "))
      .join("\n");
  }

  const res = await anthropic.messages.parse({
    model: SHEET_MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: zodOutputFormat(SheetSchema, "decision_sheet") },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `次の6項目について一覧表を作ってください。

${SHEET_ITEMS.map((x, i) => `${i + 1}. key="${x.key}"（${x.label}）：${x.hint}`).join("\n")}

===== 分析 =====
${(analysis || "").slice(0, 60000)}
${metricsText ? `\n===== 業績表 =====\n${metricsText}\n` : ""}${joined}`,
      },
    ],
  });

  if (res.stop_reason === "refusal") throw new Error("判断シートの作成が拒否されました");
  if (!res.parsed_output) throw new Error("判断シートをスキーマどおりに作れませんでした");

  // 項目の順番と過不足を固定する（モデルが飛ばした項目は「不明」で埋める）
  const byKey = new Map((res.parsed_output.items || []).map((x) => [x.key, x]));
  return {
    headline: res.parsed_output.headline || "",
    customers: (res.parsed_output.customers || []).filter((c) => c.name?.trim()).slice(0, 6),
    items: SHEET_ITEMS.map((def) => {
      const x = byKey.get(def.key);
      return x
        ? { ...x, label: def.label }
        : { key: def.key, label: def.label, mark: "不明", point: "作成できませんでした", evidence: "", source_kind: "なし", source: "" };
    }),
  };
}
