import * as cheerio from "cheerio";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_PDFS_PER_URL = 8;
const MAX_PDFS_TOTAL = 15;
const MAX_CHARS_PER_PDF = 30000;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

async function collectPdfLinks(pageUrl) {
  const res = await fetch(pageUrl, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    throw new Error(`ページを取得できません（ステータス ${res.status}）`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);
  const found = new Map();

  // 1. aタグから探す（表題が取れるので優先）
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
    if (found.has(absolute)) return;

    let label = $(el).text().replace(/\s+/g, " ").trim();
    if (!label) {
      label = $(el).attr("title") || fileNameOf(absolute);
    }
    found.set(absolute, label);
  });

  // 2. HTML全体から .pdf を含む文字列を拾う
  //    JavaScript用のデータとして埋め込まれている場合に対応
  const pattern = /["'(]([^"'()\s]+?\.pdf(?:\?[^"'()\s]*)?)["')]/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    let candidate = match[1].replace(/\\\//g, "/");
    let absolute;
    try {
      absolute = new URL(candidate, pageUrl).href;
    } catch {
      continue;
    }
    if (found.has(absolute)) continue;
    found.set(absolute, fileNameOf(absolute));
  }

  return Array.from(found, ([url, label]) => ({ url, label }));
}

async function extractPdfText(pdfUrl) {
  const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
  const res = await fetch(pdfUrl, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;

  const buffer = Buffer.from(await res.arrayBuffer());
  const parsed = await pdfParse(buffer);
  const text = (parsed.text || "").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return null;

  return {
    text: text.slice(0, MAX_CHARS_PER_PDF),
    pages: parsed.numpages || 0,
  };
}

export async function POST(request) {
  try {
    const { urls } = await request.json();

    const targets = (urls || [])
      .map((u) => (u || "").trim())
      .filter((u) => u.startsWith("http"));

    if (targets.length === 0) {
      return Response.json(
        { error: "URLを1つ以上入力してください（httpから始まるもの）" },
        { status: 400 }
      );
    }

    const links = [];
    const notes = [];

    for (const target of targets) {
      try {
        const found = await collectPdfLinks(target);
        if (found.length === 0) {
          notes.push(`${target} … PDFリンクが見つかりませんでした`);
          continue;
        }
        notes.push(`${target} … ${found.length}件のPDFを発見`);
        for (const item of found.slice(0, MAX_PDFS_PER_URL)) {
          if (links.length >= MAX_PDFS_TOTAL) break;
          if (!links.some((l) => l.url === item.url)) links.push(item);
        }
      } catch (e) {
        notes.push(`${target} … 取得失敗（${e.message}）`);
      }
    }

    if (links.length === 0) {
      return Response.json(
        {
          error:
            "PDFリンクが見つかりませんでした。決算短信や決算説明資料の一覧ページのURLか確認してください。年度を選択しないとPDFが表示されないページには対応していません。",
          notes,
        },
        { status: 404 }
      );
    }

    const documents = [];
    for (const link of links) {
      try {
        const extracted = await extractPdfText(link.url);
        if (extracted) {
          documents.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            label: link.label,
            url: link.url,
            text: extracted.text,
            chars: extracted.text.length,
            pages: extracted.pages,
            addedAt: new Date().toISOString(),
          });
        } else {
          notes.push(`${link.label} … テキストを読み取れず（画像PDFの可能性）`);
        }
      } catch {
        notes.push(`${link.label} … 読み取り失敗`);
      }
    }

    if (documents.length === 0) {
      return Response.json(
        { error: "PDFは見つかりましたが、テキストを読み取れませんでした", notes },
        { status: 422 }
      );
    }

    return Response.json({ documents, notes });
  } catch (e) {
    return Response.json({ error: `エラー: ${e.message}` }, { status: 500 });
  }
}
