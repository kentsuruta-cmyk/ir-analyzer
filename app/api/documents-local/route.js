import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getCompanyDir } from "../../../lib/filesave.js";
import { classifyFromLabel } from "../../../lib/classify.js";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_CHARS_PER_PDF = 200000;
const MAX_FILES = 80;

// 会社フォルダに保存済みのPDFから資料棚を組み立て直す。
// 資料棚はブラウザ側（localStorage）にしか無かったため、
//  - 「保存済みの分析を開く」で復元しても資料棚は空のまま＝チェックが付けられない
//  - 古い保存先を指したまま残ると「他社の資料」と判定されて全部消える
// という詰み方をしていた。ディスクを正として組み直せる口を用意する。

function readIndex(dir) {
  const p = path.join(dir, "_index.json");
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

// 保存先パス → 取得元URL の逆引き
function buildPathToMeta(index) {
  const map = new Map();
  for (const [url, v] of Object.entries(index)) {
    if (v?.path) map.set(v.path, { url, ...v });
  }
  return map;
}

async function extractText(buffer) {
  try {
    const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
    const parsed = await pdfParse(buffer);
    return { text: parsed.text || "", pages: parsed.numpages || 0 };
  } catch {
    return { text: "", pages: 0 };
  }
}

function listPdfs(dir) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 1 || !fs.existsSync(d)) return;
    for (const name of fs.readdirSync(d)) {
      // 要約・分析・指標のフォルダは資料ではない
      if (name.startsWith("_") && name !== "_unclassified") continue;
      const full = path.join(d, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, depth + 1);
      else if (name.toLowerCase().endsWith(".pdf")) out.push({ full, name, mtime: st.mtimeMs });
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES);
}

export async function GET(request) {
  if (process.env.VERCEL) {
    return Response.json({ error: "このAPIはVercel上では実行できません。" }, { status: 501 });
  }
  const company = (new URL(request.url).searchParams.get("company") || "").trim();
  if (!company) return Response.json({ error: "会社名がありません" }, { status: 400 });

  const dir = getCompanyDir(company);
  if (!fs.existsSync(dir)) return Response.json({ documents: [], savedDir: dir });

  try {
    const meta = buildPathToMeta(readIndex(dir));
    const files = listPdfs(dir);
    const documents = [];

    for (const f of files) {
      const m = meta.get(f.full);
      const baseLabel = f.name.replace(/\.pdf$/i, "");
      // 索引があればそれを信じる。無ければファイル名から判定する。
      const cls = m
        ? { docType: m.docType, fiscalYear: m.fiscalYear, quarter: m.quarter }
        : classifyFromLabel(baseLabel);

      const buffer = fs.readFileSync(f.full);
      const { text, pages } = await extractText(buffer);

      documents.push({
        id: crypto.randomUUID(),
        label: baseLabel,
        url: m?.url || `file://${f.full}`,
        text: text.slice(0, MAX_CHARS_PER_PDF),
        chars: Math.min(text.length, MAX_CHARS_PER_PDF),
        pages,
        addedAt: new Date(f.mtime).toISOString(),
        docType: cls.docType || "不明",
        fiscalYear: cls.fiscalYear || "不明",
        quarter: cls.quarter || "不明",
        savedPath: f.full,
        restored: true,
      });
    }

    return Response.json({ documents, savedDir: dir });
  } catch (e) {
    return Response.json({ error: `エラー: ${e.message}` }, { status: 500 });
  }
}
