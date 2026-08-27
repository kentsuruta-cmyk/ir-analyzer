import fs from "fs";
import path from "path";
import { getCompanyDir } from "../../../lib/filesave.js";

export const runtime = "nodejs";

// 保存済みの事実サマリー・分析を読み出す。
// 分析結果はブラウザのメモリ上にしか無かったため、再読み込み・ホットリロードで
// 画面から消えてしまっていた（ファイルには残っているのに見えない）。
// ディスクに書いたものを正として、いつでも復元できるようにする。

function newestFile(dir, matcher) {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".md") && matcher(f))
    .map((f) => {
      const full = path.join(dir, f);
      return { full, name: f, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return files[0] || null;
}

// 「# タイトル …（空行）対象資料: …（空行）」のヘッダーを落として本文だけにする
function stripHeader(text) {
  return text.replace(/^#[^\n]*\n[\s\S]*?\n\n/, "").trim();
}

export async function GET(request) {
  try {
    if (process.env.VERCEL) {
      return Response.json({ error: "このAPIはVercel上では実行できません。" }, { status: 501 });
    }
    const company = (new URL(request.url).searchParams.get("company") || "").trim();
    if (!company) return Response.json({ error: "会社名がありません" }, { status: 400 });

    const dir = getCompanyDir(company);
    if (!fs.existsSync(dir)) return Response.json({ analysis: null, summary: null });

    const analysisFile = newestFile(path.join(dir, "_分析"), () => true);
    const summaryFile = newestFile(path.join(dir, "_要約"), (f) => f.startsWith("_統合サマリー_"));

    const toPayload = (file) =>
      file
        ? {
            text: stripHeader(fs.readFileSync(file.full, "utf8")),
            path: file.full,
            savedAt: new Date(file.mtime).toISOString(),
          }
        : null;

    return Response.json({ analysis: toPayload(analysisFile), summary: toPayload(summaryFile) });
  } catch (e) {
    return Response.json({ error: `エラー: ${e.message}` }, { status: 500 });
  }
}
