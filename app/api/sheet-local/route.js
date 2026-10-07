import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getCompanyDir } from "../../../lib/filesave.js";
import { extractSheet } from "../../../lib/sheet.js";

export const runtime = "nodejs";
export const maxDuration = 300;

function sheetPath(company) {
  return path.join(getCompanyDir(company), "_指標", "判断シート.json");
}

// 事実サマリー（統合サマリーは二重になるので除く）
function readSummaries(company) {
  const dir = path.join(getCompanyDir(company), "_要約");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".md") && !f.startsWith("_統合サマリー_"))
    .map((f) => ({ label: f.replace(/\.md$/i, ""), text: fs.readFileSync(path.join(dir, f), "utf8") }));
}

function readMetrics(company) {
  try {
    return JSON.parse(fs.readFileSync(path.join(getCompanyDir(company), "_指標", "業績.json"), "utf8"));
  } catch {
    return null;
  }
}

// 同じ分析に対して作成中のものがあれば、それを待つ（画面の再描画で二重に走らせない）
const running = new Map();

// 分析本文から判断シートを作る。同じ分析に対して作成済みなら保存してあるものを返す。
export async function POST(request) {
  if (process.env.VERCEL) {
    return Response.json({ error: "このAPIはVercel上では実行できません。" }, { status: 501 });
  }
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || !apiKey.startsWith("sk-ant")) {
      return Response.json({ error: "ANTHROPIC_API_KEY が設定されていません。" }, { status: 500 });
    }

    const { companyName, analysis, force } = await request.json();
    const company = (companyName || "").trim();
    const text = (analysis || "").trim();
    if (!company) return Response.json({ error: "会社名がありません" }, { status: 400 });
    if (!text) return Response.json({ error: "分析がありません" }, { status: 400 });

    const analysisHash = crypto.createHash("sha256").update(text).digest("hex");
    const p = sheetPath(company);

    if (!force && fs.existsSync(p)) {
      try {
        const saved = JSON.parse(fs.readFileSync(p, "utf8"));
        // customers が無いのは得意先の抽出を入れる前に作ったシートなので、作り直す
        if (saved.analysisHash === analysisHash && Array.isArray(saved.customers)) {
          return Response.json({ sheet: saved, cached: true });
        }
      } catch {
        // 壊れていたら作り直す
      }
    }

    const key = `${company}\u0000${analysisHash}`;
    let job = running.get(key);
    if (!job) {
      job = (async () => {
        const sheet = await extractSheet({
          analysis: text,
          summaries: readSummaries(company),
          metrics: readMetrics(company),
          apiKey,
        });
        const out = { ...sheet, analysisHash, createdAt: new Date().toISOString() };
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(out, null, 2));
        return out;
      })();
      running.set(key, job);
      job.then(() => running.delete(key), () => running.delete(key));
    }

    return Response.json({ sheet: await job, cached: false });
  } catch (e) {
    return Response.json({ error: `エラー: ${e.message}` }, { status: 500 });
  }
}
