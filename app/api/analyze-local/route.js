import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { getCompanyDir } from "../../../lib/filesave.js";

export const runtime = "nodejs";
export const maxDuration = 300;

const ANALYSIS_MODEL = "claude-opus-5";
const MAX_TOTAL_CHARS = 150000;

const RULES = `あなたは経験豊富な株式投資アナリストです。与えられた「事実サマリー（企業の一次情報を、数値の推移・変化点・最新の見通しに絞って忠実にまとめたもの）」を土台に、投資判断を述べます。数値の推移そのものは事実サマリー側に既にあるので、分析では繰り返しません。

【絶対に守るルール】
1. 会社の財務数値・事実は、提供された「事実サマリー」に書かれているものだけを使う。無い会社の数字は作らない・推測しない。
2. 数字の表や網羅的な数値の羅列はしない（それは事実サマリーの役割）。判断の根拠として必要な数字だけ、最小限を引用する。
3. 「事実（サマリーからの引用）」と「あなたの解釈・見立て（【所見】）」を分ける。サマリーに根拠が無いことは「サマリーからは判断できません」と明記する。
4. 確度が低い点は正直に述べる。断定より正確さを優先する。

【出力（日本語・ですます調・簡潔に）】

## 総括
（結論から2〜3行。今どういう局面か、投資妙味の有無を端的に）

## ポテンシャル（こうなれば上がる）
（【所見】上振れにつながる条件・イベント。箇条書き2〜4点。事実サマリーの変化点や見通しと関連づける）

## リスク（こうなれば下がる）
（【所見】下振れ・悪化につながる要因。箇条書き2〜4点）

## 着眼点（次に確認すべきこと）
（今後フォローすべき数字・イベントを箇条書きで数点）`;

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

    // 外部情報ONのとき：Web検索で業界・競合をリサーチし、分析コメントに織り込む。
    // 二層構造を守る＝「会社自身の事実は要約から／外部の話は出典付きで」。
    const externalBlock = external
      ? `\n\n【この分析ではWeb検索が使えます（外部リサーチ可・上のルール1の例外）】
- 業界動向・競合他社・市況など、事実サマリーに無い情報はWeb検索で調べ、投資判断に織り込んでよい。同業との位置づけ（シェア・成長率・利益率の比較感）や、業界の追い風/逆風を積極的に補ってよい。
- ただし二層を厳守する：
  ・**会社自身の実績数値・見通し**は、必ず「事実サマリー」からのみ引く（外部の数字で上書きしない）。
  ・**外部（業界・競合）由来の記述**には、必ずその場に出典（媒体名・可能ならURL・時期）を添える。裏取りできない噂・古い情報は書かない。
- 外部情報は独立セクションに隔離せず、「総括」「ポテンシャル」「リスク」「着眼点」の中で、会社の実績と関連づけて自然に使う。ただし読み手が「これは外部の話」と分かるよう、出典で明示する。
- 業界内での立ち位置がひと目で分かるよう、必要なら「## 業界内での位置づけ」を1つ加えてよい（競合との簡単な比較。各記述に出典）。`
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
