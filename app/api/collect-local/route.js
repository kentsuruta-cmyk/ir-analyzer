import { crawlForPdfLinks } from "../../../lib/crawler.js";
import { classifyFromLabel, classifyBatchWithClaude } from "../../../lib/classify.js";
import { saveDocument, saveReferenceDocument, getCompanyDir } from "../../../lib/filesave.js";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_PDFS_TOTAL = 40;
const MAX_CHARS_PER_PDF = 30000;
const CLASSIFY_TEXT_CHARS = 3000;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

async function downloadPdf(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`ダウンロード失敗（ステータス ${res.status}）`);
  return Buffer.from(await res.arrayBuffer());
}

async function extractPdfText(buffer) {
  const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
  const parsed = await pdfParse(buffer);
  const text = (parsed.text || "").replace(/\n{3,}/g, "\n\n").trim();
  return { text, pages: parsed.numpages || 0 };
}

// URLが直接PDFを指しているか（証券会社レポートの直リンクなど）。
// その場合はクロールせず、そのまま1件の参考資料として取り込む。
function isDirectPdf(url) {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

export async function POST(request) {
  if (process.env.VERCEL) {
    return Response.json(
      { error: "このAPIはVercel上では実行できません。ローカル（npm run dev / npm start）で実行してください。" },
      { status: 501 }
    );
  }

  let browser;
  try {
    const { companyName, tickerCode, urls } = await request.json();

    const company = (companyName || "").trim();
    if (!company) {
      return Response.json({ error: "会社名を入力してください" }, { status: 400 });
    }

    const targets = (urls || [])
      .map((u) => (u || "").trim())
      .filter((u) => u.startsWith("http"));

    if (targets.length === 0) {
      return Response.json(
        { error: "URLを1つ以上入力してください（httpから始まるもの）" },
        { status: 400 }
      );
    }

    const pdfTargets = targets.filter(isDirectPdf);
    const pageTargets = targets.filter((u) => !isDirectPdf(u));

    const notes = [];
    const allLinks = [];

    // IR一覧ページはブラウザで巡回する（直リンクPDFしか無ければ起動しない）
    if (pageTargets.length > 0) {
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ userAgent: UA });

      for (const target of pageTargets) {
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        try {
          const { links, interactionsPerformed, timedOut } = await crawlForPdfLinks(page, target);
          if (links.length === 0) {
            notes.push(`${target} … PDFリンクが見つかりませんでした`);
          } else {
            notes.push(
              `${target} … ${links.length}件のPDFを発見（操作${interactionsPerformed}回${timedOut ? "・時間切れで打ち切り" : ""}）`
            );
            for (const link of links) {
              if (allLinks.length >= MAX_PDFS_TOTAL) break;
              if (!allLinks.some((l) => l.url === link.url)) allLinks.push(link);
            }
          }
        } catch (e) {
          notes.push(`${target} … 取得失敗（${e.message}）`);
        } finally {
          await page.close().catch(() => {});
        }
      }

      await browser.close();
      browser = null;
    }

    if (allLinks.length === 0 && pdfTargets.length === 0) {
      return Response.json({ error: "PDFリンクが見つかりませんでした", notes }, { status: 404 });
    }

    // 1. まずダウンロード＋ラベルベースの決定的分類（LLM不要）
    const items = [];
    for (const link of allLinks) {
      try {
        const buffer = await downloadPdf(link.url);
        const { text, pages } = await extractPdfText(buffer);
        // テキストが取れない画像PDF（有価証券報告書のスキャン等）でも、
        // ファイル収集が主目的なので保存はする（NotebookLM等は画像PDFも読める）。
        const heuristic = classifyFromLabel(link.label);
        items.push({
          tempId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          label: link.label,
          url: link.url,
          buffer,
          text: text || "",
          pages,
          noText: !text,
          textPrefix: (text || "").slice(0, CLASSIFY_TEXT_CHARS),
          ...heuristic,
        });
      } catch (e) {
        notes.push(`${link.label} … 読み取り失敗（${e.message}）`);
      }
    }

    // 2. 低確信度の項目だけをバッチでLLM分類（トークン節約）
    // 本文が取れない画像PDFはLLMでも判定できないので、無駄なトークンを使わないよう除外
    const lowConfidence = items.filter((i) => i.confidence === "low" && !i.noText);
    if (lowConfidence.length > 0) {
      try {
        const results = await classifyBatchWithClaude(
          lowConfidence.map((i) => ({ tempId: i.tempId, label: i.label, textPrefix: i.textPrefix }))
        );
        const byId = new Map(results.map((r) => [r.tempId, r]));
        for (const item of lowConfidence) {
          const r = byId.get(item.tempId);
          if (r) {
            item.docType = r.docType !== "不明" ? r.docType : item.docType;
            item.fiscalYear = r.fiscalYear !== "不明" ? r.fiscalYear : item.fiscalYear;
            item.quarter = r.quarter !== "不明" ? r.quarter : item.quarter;
          }
        }
        if (!process.env.ANTHROPIC_API_KEY) {
          notes.push(`${lowConfidence.length}件は自動判定できませんでした（ANTHROPIC_API_KEY未設定）`);
        }
      } catch (e) {
        notes.push(`LLMによる分類に失敗しました（${e.message}）`);
      }
    }

    // 3. 保存
    const documents = [];
    for (const item of items) {
      const result = saveDocument({
        buffer: item.buffer,
        companyName: company,
        fiscalYear: item.fiscalYear,
        quarter: item.quarter,
        docType: item.docType,
        sourceUrl: item.url,
      });

      if (result.skipped) {
        notes.push(`${item.label} … 既に保存済みのためスキップ`);
      } else if (result.unclassified) {
        const extra = item.noText ? "（画像PDF・本文抽出不可）" : "";
        notes.push(`${item.label} … 種別/決算期を判定できず _unclassified に保存しました${extra}`);
      } else if (item.noText) {
        notes.push(`${item.label} … 保存しました（画像PDFのため本文抽出不可・NotebookLMで読めます）`);
      }

      documents.push({
        id: item.tempId,
        label: item.label,
        url: item.url,
        text: item.text.slice(0, MAX_CHARS_PER_PDF),
        chars: Math.min(item.text.length, MAX_CHARS_PER_PDF),
        pages: item.pages,
        addedAt: new Date().toISOString(),
        docType: item.docType || "不明",
        fiscalYear: item.fiscalYear || "不明",
        quarter: item.quarter || "不明",
        savedPath: result.path,
      });
    }

    // 4. 直リンクPDF（証券会社レポートなど）を参考資料として取り込む
    for (const url of pdfTargets) {
      const label = decodeURIComponent(url.split("/").pop().split("?")[0]) || url;
      try {
        const buffer = await downloadPdf(url);
        const { text, pages } = await extractPdfText(buffer);
        if (!text) {
          notes.push(`${label} … テキストを読み取れず（画像PDFの可能性）`);
          continue;
        }
        const result = saveReferenceDocument({ buffer, companyName: company, sourceUrl: url });
        notes.push(
          result.skipped
            ? `${label} … 既に保存済みのためスキップ（参考資料）`
            : `${label} … 参考資料として取り込みました`
        );
        documents.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          label,
          url,
          text: text.slice(0, MAX_CHARS_PER_PDF),
          chars: Math.min(text.length, MAX_CHARS_PER_PDF),
          pages,
          addedAt: new Date().toISOString(),
          docType: "参考資料",
          fiscalYear: "-",
          quarter: "-",
          savedPath: result.path,
        });
      } catch (e) {
        notes.push(`${label} … 取り込み失敗（${e.message}）`);
      }
    }

    return Response.json({
      documents,
      notes,
      savedDir: getCompanyDir(company),
      tickerCode: (tickerCode || "").trim(),
    });
  } catch (e) {
    return Response.json({ error: `エラー: ${e.message}` }, { status: 500 });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
