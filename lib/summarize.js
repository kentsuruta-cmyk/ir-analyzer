import Anthropic from "@anthropic-ai/sdk";

export const SUMMARY_MODEL = "claude-opus-4-8";

// 要約は「事実の忠実な抽出」。原文引用とページを必須にし、知ったかぶりを構造的に防ぐ。
function buildSummarySystem(label) {
  return `あなたはIRの一次情報（決算資料）を、書かれている内容だけで忠実に要約する専門家です。資料名は「${label}」です。

【絶対に守るルール】
1. この資料に実際に書かれていることだけを述べる。一般知識・記憶・推測は一切使わない。
2. 数値を書くときは必ず原文のまま引用し、出典ページを添える。形式：
   売上高は12,500百万円でした。〔原文: 売上高 12,500〕〔出典: ${label} P.3〕
3. 原文からそのまま抜き出せない数値・事実は書かない。
4. 表や画像から読み取れない箇所は「判読不可」と明記する。決して埋め合わせない。
5. これは「事実の抽出」であり、あなたの意見・見通し・評価は書かない（それは後段の分析で行う）。

【出力（日本語・Markdown）】
以下の見出しで、書かれている範囲だけを埋める。該当が無ければ「記載なし」と書く。
## 業績ハイライト
（売上高・営業利益・経常利益・親会社株主に帰属する当期純利益と、前年同期比。各数値に原文引用と出典ページ）
## 事業内容・セグメント
（セグメント別の売上・利益があれば数値付きで）
## 会社の見通し・重点施策
（会社自身が示す通期見通しや対処すべき課題。原文引用付き）
## リスク・特記事項
（事業等のリスク、特別損益、訂正事項など）`;
}

// PDF本体をClaudeに渡して忠実な要約Markdownを得る。
// pdfBase64: PDFのbase64文字列 / label: 資料名（引用の出典に使う）
export async function summarizePdf({ pdfBase64, label, apiKey }) {
  const anthropic = new Anthropic({ apiKey });
  const res = await anthropic.beta.messages.create({
    betas: ["pdfs-2024-09-25"],
    model: SUMMARY_MODEL,
    max_tokens: 8000,
    system: buildSummarySystem(label),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: pdfBase64 },
          },
          {
            type: "text",
            text: "この資料を、システムのルールに厳密に従って要約してください。数値には必ず原文引用と出典ページを付けてください。",
          },
        ],
      },
    ],
  });

  return res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// 複数期の決算資料を「投資判断用の事実サマリー1枚」にまとめるためのsystemプロンプト。
// 四半期ごとに繰り返さず、①数値の推移 ②変化点だけ ③最新の見通し・施策 に絞る。原文引用は必須。
function buildConsolidatedSystem(labels) {
  const list = labels.map((l, i) => `${i + 1}. ${l}`).join("\n");
  return `あなたはIRの一次情報（決算資料）を、書かれている内容だけで忠実にまとめる専門家です。次の複数期の資料が渡されます:
${list}

投資判断のための「事実サマリー」を、期をまたいで1枚にまとめます。四半期ごとに同じ項目を繰り返してはいけません。

【絶対に守るルール】
1. 各資料に実際に書かれていることだけを使う。一般知識・記憶・推測は一切使わない。
2. 数値は原文のまま引用し、どの資料（期）・ページかを添える。例: 売上高 12,500百万円〔2026年3月期3Q決算短信 P.3〕
3. 原文から抜き出せない数値や、自分で計算した数値は書かない。判読不可は「判読不可」と明記し埋め合わせない。
4. 会社自身が資料に書いた見通し・施策は事実として載せてよいが、あなたの評価・意見・見立ては書かない（それは後段の分析）。

【出力（日本語）。以下の3見出しだけ。】
## 数値の推移
主要指標（売上高・営業利益・経常利益・親会社株主に帰属する当期純利益・通期進捗率など、資料にあるもの）を、期を横（古い→新しい）に並べた、半角スペースで桁を揃えた等幅の表にする（「|」記号の表は使わない）。各セルは原文の数値。右端に直近の前期比（＋/− と率）。資料に無い指標や期は「—」、判読不可は「判読不可」。

## 変化・トピックス
期をまたいで大きく動いた点・新しい動きだけを箇条書き（大幅な増減とその理由、新規/撤退セグメント、一時要因、特別損益、通期見通しの上方/下方修正 など）。各項目に出典（期・ページ）。毎期共通の定型説明は書かない。特筆すべき変化が無ければ「特筆すべき変化なし」。

## 最新の見通し・重点施策
最も新しい資料に書かれた通期見通し・重点施策・対処すべき課題だけ。過去期の見通しは載せない。原文引用付き。`;
}

// 複数PDFを1回のAPI呼び出しでまとめて読み、統合された事実サマリーを返す。
// documents: [{ pdfBase64, label }]
export async function summarizeConsolidated({ documents, apiKey }) {
  const anthropic = new Anthropic({ apiKey });
  const content = documents.map((d) => ({
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data: d.pdfBase64 },
  }));
  content.push({
    type: "text",
    text: "上記すべての資料を突き合わせ、システムのルールに厳密に従って『事実サマリー』を1枚にまとめてください。四半期ごとに繰り返さず、数値の推移・変化点・最新の見通しに絞り、数値には原文引用と出典（期・ページ）を付けてください。",
  });
  const res = await anthropic.beta.messages.create({
    betas: ["pdfs-2024-09-25"],
    model: SUMMARY_MODEL,
    max_tokens: 8000,
    system: buildConsolidatedSystem(documents.map((d) => d.label)),
    messages: [{ role: "user", content }],
  });
  return res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
