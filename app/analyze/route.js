import * as cheerio from "cheerio";
import Anthropic from "@anthropic-ai/sdk";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_PDFS = 8;
const MAX_CHARS_PER_PDF = 12000;
const MAX_TOTAL_CHARS = 120000;

// IRページからPDFリンクを集める
async function collectPdfLinks(pageUrl) {
  const res = await fetch(pageUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
    },
  });

  if (!res.ok) {
    throw new Error(`ページを取得できませんでした（ステータス: ${res.status}）`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  const found = new Map();

  $("a").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    if (!href.toLowerCase().includes(".pdf")) return;

    let absolute;
    try {
      absolute = new URL(href, pageUrl).href;
    } catch {
      return;
    }

    const label = $(el).text().replace(/\s+/g, " ").trim();
    if (!found.has(absolute)) {
      found.set(absolute, label || absolute.split("/").pop());
    }
  });

  return Array.from(found, ([url, label]) => ({ url, label }));
}

// PDFからテキストを抜き出す
async function extractPdfText(pdfUrl) {
  const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;

  const res = await fetch(pdfUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
    },
  });

  if (!res.ok) return null;

  const buffer = Buffer.from(await res.arrayBuffer());
  const parsed = await pdfParse(buffer);
  const text = (parsed.text || "").replace(/\n{3,}/g, "\n\n").trim();

  if (!text) return null;
  return text.slice(0, MAX_CHARS_PER_PDF);
}

export async function POST(request) {
  try {
    const { url } = await request.json();

    if (!url || !url.startsWith("http")) {
      return Response.json(
        { error: "有効なURLを入力してください（httpから始まるもの）" },
        { status: 400 }
      );
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return Response.json(
        { error: "APIキーが設定されていません（Vercelの環境変数を確認してください）" },
        { status: 500 }
      );
    }

    // 1. PDFリンクを収集
    const links = await collectPdfLinks(url);

    if (links.length === 0) {
      return Response.json(
        { error: "このページにPDFリンクが見つかりませんでした。IRライブラリや決算資料の一覧ページのURLを試してください。" },
        { status: 404 }
      );
    }

    const targets = links.slice(0, MAX_PDFS);

    // 2. 各PDFのテキストを抽出
    const documents = [];
    for (const target of targets) {
      try {
        const text = await extractPdfText(target.url);
        if (text) {
          documents.push({ label: target.label, url: target.url, text });
        }
      } catch {
        // 読めないPDFは飛ばす
      }
    }

    if (documents.length === 0) {
      return Response.json(
        { error: "PDFは見つかりましたが、テキストを読み取れませんでした（画像PDFの可能性があります）" },
        { status: 422 }
      );
    }

    // 3. Claudeに渡す本文を組み立て
    let combined = "";
    for (const doc of documents) {
      const block = `\n\n===== 資料: ${doc.label} =====\n出典: ${doc.url}\n\n${doc.text}`;
      if (combined.length + block.length > MAX_TOTAL_CHARS) break;
      combined += block;
    }

    // 4. Claudeで分析
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 4000,
      messages: [
        {
          role: "user",
          content: `以下は、ある企業のIRページから自動収集した資料のテキストです。株式投資の判断材料として、以下の観点で日本語で分析してください。

【分析の観点】
1. 業績サマリー（売上高・営業利益・経常利益の推移と前年同期比）
2. 業績の変化要因（なぜ伸びたか / なぜ落ちたか）
3. 会社側の今期見通しと、その達成度・修正の有無
4. 事業セグメント別の状況（記載がある場合）
5. 注目すべきポジティブ要因
6. 注目すべきリスク・懸念点
7. 総合所見（3〜5行）

【注意】
- 資料に書かれていない数値を推測で書かないでください。不明な場合は「資料に記載なし」と明記してください。
- 数値は可能な限り具体的に引用してください。
- 見出しごとに整理して読みやすく書いてください。

${combined}`,
        },
      ],
    });

    const analysis = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    return Response.json({
      analysis,
      documentCount: documents.length,
      foundCount: links.length,
    });
  } catch (e) {
    return Response.json(
      { error: `分析中にエラーが発生しました: ${e.message}` },
      { status: 500 }
    );
  }
}
