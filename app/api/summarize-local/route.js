import fs from "fs";
import path from "path";
import crypto from "crypto";
import { summarizePdf, consolidateSummaries } from "../../../lib/summarize.js";
import {
  getPageCount,
  withinLimits,
  trimToRelevantSections,
  MAX_PAGES,
} from "../../../lib/pdfselect.js";
import { getCompanyDir, IR_ROOT } from "../../../lib/filesave.js";

export const runtime = "nodejs";
export const maxDuration = 600;

// 実行中の要約を資料の組み合わせごとに共有するための置き場。
// 要約は7分以上かかることがあり、その間に接続が切れるとブラウザは投げ直す（fetchLongRunning）。
// 束ねないと同じPDFを読む要約がもう1本並列で走り、APIを取り合って全体が遅くなる。
const jobCache = new Map();
const JOB_TTL_MS = 15 * 60 * 1000;

// savedPath が「対象会社のフォルダ配下」の .pdf であることを検証する。
// IR資料配下というだけでは不十分：他社のPDFを渡されると、その会社の要約フォルダに
// 別会社の内容が書き込まれてしまう（フロントに前の会社の資料が残っていた場合に発生する）。
function safePdfPath(savedPath, companyDir) {
  if (!savedPath || typeof savedPath !== "string") return null;
  const resolved = path.resolve(savedPath);
  if (!resolved.startsWith(IR_ROOT + path.sep)) return null;
  if (!resolved.startsWith(path.resolve(companyDir) + path.sep)) return null;
  if (!resolved.toLowerCase().endsWith(".pdf")) return null;
  if (!fs.existsSync(resolved)) return null;
  return resolved;
}

// 除外理由をユーザーに伝えるため、そのPDFがどの会社のものかを取り出す
function otherCompanyOf(savedPath, companyDir) {
  if (!savedPath || typeof savedPath !== "string") return null;
  const resolved = path.resolve(savedPath);
  if (!resolved.startsWith(IR_ROOT + path.sep)) return null;
  if (resolved.startsWith(path.resolve(companyDir) + path.sep)) return null;
  return resolved.slice(IR_ROOT.length + 1).split(path.sep)[0] || null;
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

    const companyDir = getCompanyDir(company);
    const outDir = path.join(companyDir, "_要約");
    const notes = [];
    const prepared = []; // { pdfBase64, label, pdfPath }

    // 選択された各PDFを準備（ページ超過は必要セクション抜粋、巨大/画像は除外）
    for (const doc of docs) {
      const label = doc.label || "資料";
      const pdfPath = safePdfPath(doc.savedPath, companyDir);
      if (!pdfPath) {
        const other = otherCompanyOf(doc.savedPath, companyDir);
        notes.push(
          other
            ? `${label} … 「${other}」の資料のため除外（対象は「${company}」です）`
            : `${label} … 保存済みPDFが見つからずスキップ`
        );
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

    // ── map: 各PDFを1件ずつ要約（PDFはここでしか渡さない＝トークン上限に当たらない）。
    //    ファイル単位でキャッシュし、既に要約済みなら再課金しない。並列度を絞って maxDuration 内に収める。
    async function summarizeOne(p) {
      const fileKey = crypto
        .createHash("sha256")
        .update(path.basename(p.pdfPath) + ":" + p.pdfBase64.length)
        .digest("hex")
        .slice(0, 12);
      const perPath = path.join(outDir, `_個別_${fileKey}.md`);
      if (fs.existsSync(perPath)) {
        return { label: p.label, text: fs.readFileSync(perPath, "utf8"), cached: true };
      }
      const text = await summarizePdf({ pdfBase64: p.pdfBase64, label: p.label, apiKey });
      if (text) fs.writeFileSync(perPath, text + "\n");
      return { label: p.label, text, cached: false };
    }

    // 個別要約（map）→統合（reduce）。結果はResponseではなくデータで返し、
    // 相乗りした側でも新しいResponseを作れるようにする。
    async function runSummarize() {
      const jobNotes = [];
      const CONCURRENCY = 4;
      const perDoc = [];
      let cachedCount = 0;
      for (let i = 0; i < prepared.length; i += CONCURRENCY) {
        const batch = prepared.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(batch.map(summarizeOne));
        results.forEach((r, j) => {
          const label = batch[j].label;
          if (r.status === "fulfilled" && r.value.text) {
            perDoc.push({ label, text: r.value.text });
            if (r.value.cached) cachedCount++;
          } else {
            const msg = r.status === "rejected" ? r.reason?.message || String(r.reason) : "本文を読み取れず";
            jobNotes.push(`${label} … 個別要約に失敗（${msg}）`);
          }
        });
      }

      if (perDoc.length === 0) {
        return {
          status: 502,
          error: "個別要約を1件も作成できませんでした（対象PDFを読み取れず）。",
          notes: jobNotes,
        };
      }
      if (cachedCount > 0) jobNotes.push(`${cachedCount}件は要約済みを再利用（再課金なし）`);

      // ── reduce: 個別要約テキストだけを突き合わせて1枚の事実サマリーに（PDFは渡さない）
      const text = await consolidateSummaries({ summaries: perDoc, apiKey });

      if (!text) {
        return { status: 502, error: "事実サマリーを生成できませんでした。", notes: jobNotes };
      }

      const header = `# 事実サマリー（統合）\n\n対象資料:\n${perDoc
        .map((p) => `- ${p.label}`)
        .join("\n")}\n\n`;
      fs.writeFileSync(mdPath, header + text + "\n");
      jobNotes.push(`${perDoc.length}件を個別要約→統合して事実サマリーを作成`);
      return { status: 200, text, notes: jobNotes };
    }

    // 同じ資料の組み合わせの要約が走っていれば、それに相乗りする（二重実行・二重課金を防ぐ）
    const jobKey = `${path.resolve(outDir)}::${setKey}`;
    let job = jobCache.get(jobKey);
    const joinedRunning = Boolean(job);
    if (!job) {
      job = runSummarize();
      jobCache.set(jobKey, job);
      job.then(
        () => {
          const t = setTimeout(() => jobCache.delete(jobKey), JOB_TTL_MS);
          if (typeof t.unref === "function") t.unref();
        },
        () => jobCache.delete(jobKey)
      );
    }
    const result = await job;

    const allNotes = [...notes, ...(result.notes || [])];
    if (joinedRunning) {
      allNotes.push("同じ要約がすでに実行中だったので、その結果を共有しました（再課金なし）");
    }
    if (result.status !== 200) {
      return Response.json({ error: result.error, notes: allNotes }, { status: result.status });
    }

    return Response.json({
      summaries: [{ label: "事実サマリー", text: result.text }],
      notes: allNotes,
      summaryDir: outDir,
    });
  } catch (e) {
    return Response.json({ error: `エラー: ${e.message}` }, { status: 500 });
  }
}
