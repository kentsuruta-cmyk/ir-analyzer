import fs from "fs";
import path from "path";
import os from "os";
import { summarizePdf } from "../../../lib/summarize.js";
import {
  getPageCount,
  withinLimits,
  trimToRelevantSections,
  MAX_PAGES,
} from "../../../lib/pdfselect.js";
import { getCompanyDir } from "../../../lib/filesave.js";

export const runtime = "nodejs";
export const maxDuration = 300;

const IR_ROOT = path.join(os.homedir(), "Documents", "IR資料");

// savedPath が IR資料フォルダ配下の .pdf であることを検証（パストラバーサル対策）
function safePdfPath(savedPath) {
  if (!savedPath || typeof savedPath !== "string") return null;
  const resolved = path.resolve(savedPath);
  if (!resolved.startsWith(IR_ROOT + path.sep)) return null;
  if (!resolved.toLowerCase().endsWith(".pdf")) return null;
  if (!fs.existsSync(resolved)) return null;
  return resolved;
}

export async function POST(request) {
  if (process.env.VERCEL) {
    return Response.json(
      { error: "このAPIはVercel上では実行できません。ローカル（npm run dev/start）で実行してください。" },
      { status: 501 }
    );
  }

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || !apiKey.startsWith("sk-ant")) {
      return Response.json(
        { error: "APIキーが正しく設定されていません。.env.local に ANTHROPIC_API_KEY=sk-ant... を設定し、サーバーを再起動してください。" },
        { status: 500 }
      );
    }

    const { companyName, documents } = await request.json();
    const company = (companyName || "").trim();
    const docs = Array.isArray(documents) ? documents : [];

    if (!company) {
      return Response.json({ error: "会社名がありません" }, { status: 400 });
    }
    if (docs.length === 0) {
      return Response.json({ error: "要約する資料を1件以上選択してください" }, { status: 400 });
    }

    const outDir = path.join(getCompanyDir(company), "_要約");
    const notes = [];
    const summaries = [];

    for (const doc of docs) {
      const label = doc.label || "資料";
      const pdfPath = safePdfPath(doc.savedPath);
      if (!pdfPath) {
        notes.push(`${label} … 保存済みPDFが見つからず要約をスキップ`);
        continue;
      }

      try {
        let buffer = fs.readFileSync(pdfPath);
        let note = "";

        // ページ数チェックはpdf-libで行うが、解析できないPDF（野村等の特殊構造）もある。
        // 失敗してもページ数不明として続行し、そのままClaudeに渡す（Claudeの方が頑健）。
        let pageCount = null;
        try {
          pageCount = await getPageCount(buffer);
        } catch {
          pageCount = null;
        }

        // ページ数が分かり、かつ上限超なら有報セクション抜粋を試みる
        if (pageCount != null && !withinLimits(buffer, pageCount)) {
          try {
            const { trimmed, reason, keptPages } = await trimToRelevantSections(buffer);
            if (trimmed) {
              buffer = trimmed;
              note = `（${pageCount}頁→必要セクション${keptPages}頁に抜粋）`;
            } else if (reason === "image") {
              notes.push(
                `${label} … ${pageCount}頁の画像PDFで${MAX_PAGES}頁を超えるため要約不可。NotebookLM推奨`
              );
              continue;
            } else {
              notes.push(
                `${label} … ${pageCount}頁で${MAX_PAGES}頁を超え、章を特定できず要約不可。NotebookLM推奨`
              );
              continue;
            }
          } catch {
            // 抜粋にも失敗した場合はそのままClaudeに渡す（上限超なら後段でエラーになる）
          }
        }

        // サイズが明確に上限超なら送らない（Claudeの32MB制限対策）
        if (buffer.length > 30 * 1024 * 1024) {
          notes.push(`${label} … ファイルが大きすぎるため要約不可。NotebookLM推奨`);
          continue;
        }

        const summary = await summarizePdf({
          pdfBase64: buffer.toString("base64"),
          label,
          apiKey,
        });

        fs.mkdirSync(outDir, { recursive: true });
        const mdName = path.basename(pdfPath).replace(/\.pdf$/i, "") + ".md";
        const mdPath = path.join(outDir, mdName);
        fs.writeFileSync(mdPath, `# ${label} 要約\n\n出典PDF: ${pdfPath}\n\n${summary}\n`);

        summaries.push({ label, savedPath: pdfPath, mdPath, text: summary });
        notes.push(`${label} … 要約を作成${note}`);
      } catch (e) {
        notes.push(`${label} … 要約失敗（${e.message}）`);
      }
    }

    return Response.json({ summaries, notes, summaryDir: outDir });
  } catch (e) {
    return Response.json({ error: `エラー: ${e.message}` }, { status: 500 });
  }
}
