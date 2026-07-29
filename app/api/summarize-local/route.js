import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { summarizeConsolidated } from "../../../lib/summarize.js";
import {
  getPageCount,
  withinLimits,
  trimToRelevantSections,
  MAX_PAGES,
} from "../../../lib/pdfselect.js";
import { getCompanyDir } from "../../../lib/filesave.js";

export const runtime = "nodejs";
export const maxDuration = 600;

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
    const prepared = []; // { pdfBase64, label, pdfPath }

    // 選択された各PDFを準備（ページ超過は必要セクション抜粋、巨大/画像は除外）
    for (const doc of docs) {
      const label = doc.label || "資料";
      const pdfPath = safePdfPath(doc.savedPath);
      if (!pdfPath) {
        notes.push(`${label} … 保存済みPDFが見つからずスキップ`);
        continue;
      }
      try {
        let buffer = fs.readFileSync(pdfPath);

        let pageCount = null;
        try {
          pageCount = await getPageCount(buffer);
        } catch {
          pageCount = null;
        }

        if (pageCount != null && !withinLimits(buffer, pageCount)) {
          try {
            const { trimmed, reason, keptPages } = await trimToRelevantSections(buffer);
            if (trimmed) {
              buffer = trimmed;
              notes.push(`${label} … ${pageCount}頁→必要セクション${keptPages}頁に抜粋`);
            } else if (reason === "image") {
              notes.push(`${label} … ${pageCount}頁の画像PDFで${MAX_PAGES}頁超のため除外。NotebookLM推奨`);
              continue;
            } else {
              notes.push(`${label} … ${pageCount}頁で章を特定できず除外。NotebookLM推奨`);
              continue;
            }
          } catch {
            // 抜粋に失敗してもそのまま渡す（上限超なら後段でエラーになる）
          }
        }

        if (buffer.length > 30 * 1024 * 1024) {
          notes.push(`${label} … ファイルが大きすぎるため除外。NotebookLM推奨`);
          continue;
        }

        prepared.push({ pdfBase64: buffer.toString("base64"), label, pdfPath });
      } catch (e) {
        notes.push(`${label} … 読み込み失敗（${e.message}）`);
      }
    }

    if (prepared.length === 0) {
      return Response.json(
        { error: "要約できる資料がありませんでした（PDFを読み取れず）。", notes },
        { status: 400 }
      );
    }

    fs.mkdirSync(outDir, { recursive: true });

    // 同じ資料の組み合わせは要約済みなら再利用（再課金なし）
    const setKey = crypto
      .createHash("sha256")
      .update(prepared.map((p) => path.basename(p.pdfPath)).sort().join("|"))
      .digest("hex")
      .slice(0, 10);
    const mdPath = path.join(outDir, `_統合サマリー_${setKey}.md`);

    if (fs.existsSync(mdPath)) {
      const text = fs.readFileSync(mdPath, "utf8").replace(/^#[^\n]*\n[\s\S]*?\n\n/, "");
      notes.push("同じ資料の組み合わせは要約済み（スキップ・再課金なし）");
      return Response.json({ summaries: [{ label: "事実サマリー", text }], notes, summaryDir: outDir });
    }

    // 複数PDFをまとめて1枚の事実サマリーに
    const text = await summarizeConsolidated({
      documents: prepared.map(({ pdfBase64, label }) => ({ pdfBase64, label })),
      apiKey,
    });

    if (!text) {
      return Response.json(
        { error: "事実サマリーを生成できませんでした（対象PDFを読み取れず）。", notes },
        { status: 502 }
      );
    }

    const header = `# 事実サマリー（統合）\n\n対象資料:\n${prepared
      .map((p) => `- ${p.label}`)
      .join("\n")}\n\n`;
    fs.writeFileSync(mdPath, header + text + "\n");
    notes.push(`${prepared.length}件をまとめて事実サマリーを作成`);

    return Response.json({ summaries: [{ label: "事実サマリー", text }], notes, summaryDir: outDir });
  } catch (e) {
    return Response.json({ error: `エラー: ${e.message}` }, { status: 500 });
  }
}
