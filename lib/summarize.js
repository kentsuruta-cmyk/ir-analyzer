import Anthropic from "@anthropic-ai/sdk";

export const SUMMARY_MODEL = "claude-opus-5";

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
