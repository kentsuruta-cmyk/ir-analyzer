import fs from "fs";
import path from "path";
import { getCompanyDir } from "../../../lib/filesave.js";
import { extractMetrics } from "../../../lib/metrics.js";

export const runtime = "nodejs";
export const maxDuration = 300;

const OUT_NAME = "業績.json";

function metricsPath(company) {
  return path.join(getCompanyDir(company), "_指標", OUT_NAME);
}

// analyze-local と同じ考え方で、選択中の資料に対応する要約だけを読む。
// 選択が無いときはフォルダ内の全要約（統合サマリーは除く＝二重計上を避ける）。
function readSummaries(company, documents) {
  const dir = path.join(getCompanyDir(company), "_要約");
  if (!fs.existsSync(dir)) return [];

  if (Array.isArray(documents) && documents.length > 0) {
    const items = [];
    for (const d of documents) {
      if (!d.savedPath) continue;
      const md = path.join(dir, path.basename(d.savedPath).replace(/\.pdf$/i, "") + ".md");
      if (fs.existsSync(md)) {
        items.push({ label: d.label || path.basename(md), text: fs.readFileSync(md, "utf8") });
      }
    }
    if (items.length > 0) return items;
  }

  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".md") && !f.startsWith("_統合サマリー_"))
    .map((f) => ({
      label: f.replace(/\.md$/i, ""),
      text: fs.readFileSync(path.join(dir, f), "utf8"),
    }));
}

// 保存済みの業績データを返す（画面の再読み込みで消えないように）
export async function GET(request) {
  if (process.env.VERCEL) {
    return Response.json({ error: "このAPIはVercel上では実行できません。" }, { status: 501 });
  }
  const company = (new URL(request.url).searchParams.get("company") || "").trim();
  if (!company) return Response.json({ error: "会社名がありません" }, { status: 400 });

  const p = metricsPath(company);
  if (!fs.existsSync(p)) return Response.json({ metrics: null });
  try {
    const stat = fs.statSync(p);
    return Response.json({
      metrics: JSON.parse(fs.readFileSync(p, "utf8")),
      savedAt: new Date(stat.mtimeMs).toISOString(),
    });
  } catch (e) {
    return Response.json({ metrics: null, error: `保存済みデータを読めませんでした: ${e.message}` });
  }
}

export async function POST(request) {
  if (process.env.VERCEL) {
    return Response.json(
      { error: "このAPIはVercel上では実行できません。ローカルで実行してください。" },
      { status: 501 }
    );
  }

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || !apiKey.startsWith("sk-ant")) {
      return Response.json({ error: "ANTHROPIC_API_KEY が設定されていません。" }, { status: 500 });
    }

    const { companyName, documents } = await request.json();
    const company = (companyName || "").trim();
    if (!company) return Response.json({ error: "会社名がありません" }, { status: 400 });

    const summaries = readSummaries(company, documents);
    if (summaries.length === 0) {
      return Response.json(
        { error: "業績表の元になる要約がありません。先に要約を作成してください。" },
        { status: 400 }
      );
    }

    const metrics = await extractMetrics({ summaries, apiKey });

    const p = metricsPath(company);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(metrics, null, 2));

    return Response.json({ metrics, metricsPath: p, included: summaries.map((s) => s.label) });
  } catch (e) {
    return Response.json({ error: `エラー: ${e.message}` }, { status: 500 });
  }
}
