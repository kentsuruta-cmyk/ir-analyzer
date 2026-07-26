import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { getCompanyDir } from "../../../lib/filesave.js";

export const runtime = "nodejs";
export const maxDuration = 300;

const ANALYSIS_MODEL = "claude-opus-4-8";
const MAX_TOTAL_CHARS = 150000;

const RULES = `あなたは経験豊富な株式投資アナリストです。与えられた「要約（企業の一次情報を忠実に抽出したもの）」だけを根拠に分析します。読み手が短時間で判断できる、簡潔な投資メモを書きます。

【絶対に守るルール】
1. 提供された要約に書かれている数値・事実だけを根拠にする。要約に無い数字や一般知識は使わない。
2. 複数期の要約が渡されても、四半期ごとに分けて数字を羅列しない。まず要約の中で「最新期」を特定し、その最新の実績と会社見通しを"基準"に据える。過去の期は、増収/減収・改善/悪化といった「流れ」を一言で語るためだけに使う。
3. 数字は判断に効くものだけに絞る（最新期の売上・利益・通期進捗率・会社の通期見通しなど）。要約にある数値を網羅的に書き写さない。一目で掴めることを最優先する。
4. 「事実（要約からの引用）」と「あなたの解釈・見立て（【所見】）」を分ける。要約に根拠が無いことは推測で埋めず「要約からは判断できません」と明記する。
5. 確度が低い点は正直にその旨を述べる。断定より正確さを優先する。

【出力（日本語・Markdown・ですます調。全体で簡潔に。数値の長い羅列は禁止）】
## 最新の実績と会社見通し
（最新期がいつかを明記し、実績の要点と会社の通期見通し・進捗率を、数字を絞って3〜5行で。過去との対比は「流れ」を一言だけ）
## 強気シナリオ（こうなれば上がる）
（【所見】どんな条件・イベントが実現すれば業績・株価の上振れにつながるか。箇条書き2〜4点で簡潔に）
## リスクシナリオ（こうなれば下がる）
（【所見】何が起きると下振れ・悪化リスクか。箇条書き2〜4点で簡潔に）
## 着眼点（次に確認すべきこと）
（今後フォローすべき数字・イベントを箇条書きで数点だけ）`;

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

    const { companyName, summaries, documents, question, profile, external } = await request.json();
    const company = (companyName || "").trim();
    if (!company) {
      return Response.json({ error: "会社名がありません" }, { status: 400 });
    }

    // 分析対象の要約を決める（優先順）:
    // 1. documents（選択中の資料）が来たら、その資料の要約だけを使う（古い要約の混入を防ぐ）
    // 2. summaries が直接来たらそれ
    // 3. どちらも無ければフォルダ内の全要約（後方互換）
    let items = [];
    if (Array.isArray(documents) && documents.length > 0) {
      const dir = path.join(getCompanyDir(company), "_要約");
      for (const d of documents) {
        if (!d.savedPath) continue;
        const md = path.join(dir, path.basename(d.savedPath).replace(/\.pdf$/i, "") + ".md");
        if (fs.existsSync(md)) {
          items.push({ label: d.label || path.basename(md), text: fs.readFileSync(md, "utf8") });
        }
      }
      if (items.length === 0) {
        return Response.json(
          { error: "選択した資料の要約が見つかりません。先に「選択資料の要約を作成」してください。" },
          { status: 400 }
        );
      }
    } else if (Array.isArray(summaries) && summaries.length > 0) {
      items = summaries.filter((s) => s && s.text);
    } else {
      items = readSummariesFromDisk(company);
    }

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

    // 外部情報（競合・業界）を持ち込む場合だけ、Web検索を許可し、外部由来は
    // 出典付きの専用セクションに隔離する。要約ベースの判断（上のRULES）とは混ぜない。
    const externalBlock = external
      ? `\n\n【外部情報の扱い（この分析ではWeb検索が使えます）】
- 競合・業界の状況など、要約に無い情報はWeb検索で調べてよい。ただし必ず「## 競合・業界の状況（外部情報）」という専用セクションにまとめ、それ以外のセクション（最新の実績・シナリオ等）には外部情報を混ぜない。
- 外部情報の各記述には、出典（媒体名・可能ならURL）を必ず添える。裏取りできない噂は書かない。
- 「## 競合・業界の状況（外部情報）」を、着眼点の前に追加すること。要約由来の事実と外部由来の情報が、読み手に明確に区別できるようにする。`
      : "";

    const system = `${RULES}${profileBlock}${externalBlock}\n\n【参照可能な要約は以下がすべてです】${block}`;
    const anthropic = new Anthropic({ apiKey });

    // 外部情報ON時はWeb検索ツール（サーバー側実行・出典付き）を渡す。
    const tools = external
      ? [{ type: "web_search_20260209", name: "web_search", max_uses: 6 }]
      : undefined;

    // Web検索はサーバー側でループするため、上限に達すると stop_reason=pause_turn で返る。
    // その場合は会話を継ぎ足して再開する。
    const messages = [{ role: "user", content: userText }];
    let response;
    for (let i = 0; i < 6; i++) {
      response = await anthropic.messages.create({
        model: ANALYSIS_MODEL,
        max_tokens: 6000,
        system,
        messages,
        ...(tools ? { tools } : {}),
      });
      if (response.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: response.content });
    }

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
