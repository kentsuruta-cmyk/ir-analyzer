import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { getCompanyDir } from "../../../lib/filesave.js";

export const runtime = "nodejs";
export const maxDuration = 300;

const ANALYSIS_MODEL = "claude-opus-4-8";
const MAX_TOTAL_CHARS = 150000;

const RULES = `あなたは経験豊富な株式投資アナリストです。与えられた「要約（企業の一次情報を忠実に抽出したもの）」だけを根拠に分析します。

【絶対に守るルール】
1. 提供された要約に書かれている数値・事実だけを根拠にする。要約に無い数字や一般知識は使わない。
2. 「事実（要約からの引用）」と「あなたの解釈・見立て」を明確に分ける。解釈には【所見】という見出しを付ける。
3. 要約から計算して導いた数値は「（要約の数値から算出）」と明記し、元の数値も示す。
4. 要約に根拠が無いことは推測で埋めず「要約からは判断できません」と明記する。
5. 確度が低い点は正直にその旨を述べる。断定より正確さを優先する。

【出力（日本語・Markdown・ですます調）】
## 業績の評価
（売上・利益の推移と、その背景。要約の数値を引用しつつ）
## 成長性の見通し
（会社が示す見通しと、そこから読み取れる成長性。事実と【所見】を分ける）
## リスク・懸念点
## 投資上の着眼点
（【所見】として、注目すべき指標や今後の確認ポイント）`;

// _要約フォルダから既存の要約Markdownを読み込む
function readSummariesFromDisk(company) {
  const dir = path.join(getCompanyDir(company), "_要約");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".md"))
    .map((f) => ({
      label: f.replace(/\.md$/i, ""),
      text: fs.readFileSync(path.join(dir, f), "utf8"),
    }));
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

    const { companyName, summaries, question, profile } = await request.json();
    const company = (companyName || "").trim();
    if (!company) {
      return Response.json({ error: "会社名がありません" }, { status: 400 });
    }

    // クライアントから要約が渡されればそれを、無ければディスクの_要約から読む
    let items = Array.isArray(summaries) && summaries.length > 0
      ? summaries.filter((s) => s && s.text)
      : readSummariesFromDisk(company);

    if (items.length === 0) {
      return Response.json(
        { error: "分析の元になる要約がありません。先に「要約を作成」してください。" },
        { status: 400 }
      );
    }

    let block = "";
    const included = [];
    for (const s of items) {
      const chunk = `\n\n===== 要約: ${s.label} =====\n${s.text}\n===== ここまで =====`;
      if (block.length + chunk.length > MAX_TOTAL_CHARS) break;
      block += chunk;
      included.push(s.label);
    }

    const userText = (question || "").trim()
      ? `次の観点を特に重視して分析してください: ${question.trim()}`
      : `${company} の事業内容・業績・将来の成長性見通しを分析してください。`;

    // ユーザーの分析プロファイル（観点・手法・口調）を反映。ただし上のRULES（引用強制・
    // 事実と所見の分離・要約に無いことは述べない）は厳守で、プロファイルはそれを上書きしない。
    const profileBlock = (profile || "").trim()
      ? `\n\n【分析者の視点・重視する観点（この観点・スタイルで分析してください。ただし上の絶対ルールは厳守）】\n${profile.trim()}`
      : "";

    const system = `${RULES}${profileBlock}\n\n【参照可能な要約は以下がすべてです】${block}`;
    const anthropic = new Anthropic({ apiKey });
    const response = await anthropic.messages.create({
      model: ANALYSIS_MODEL,
      max_tokens: 6000,
      system,
      messages: [{ role: "user", content: userText }],
    });

    const analysis = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    const outDir = path.join(getCompanyDir(company), "_分析");
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const mdPath = path.join(outDir, `${company}_分析_${stamp}.md`);
    fs.writeFileSync(
      mdPath,
      `# ${company} 分析（${stamp}）\n\n対象要約: ${included.join(" / ")}\n\n${analysis}\n`
    );

    return Response.json({ analysis, analysisPath: mdPath, included });
  } catch (e) {
    return Response.json({ error: `エラー: ${e.message}` }, { status: 500 });
  }
}
