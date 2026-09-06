import fs from "fs";
import path from "path";
import crypto from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { getCompanyDir } from "../../../lib/filesave.js";
import { ALLOWED_DOMAINS, SOURCE_SUMMARY } from "../../../lib/sources.js";
import { RANK_RULES, buildStanceBlock } from "../../../lib/thesis.js";

export const runtime = "nodejs";
export const maxDuration = 300;

const ANALYSIS_MODEL = "claude-opus-5";
const MAX_TOTAL_CHARS = 150000;

// 実行中／直近に終わった分析を、入力の内容をキーにして共有するための置き場。
// ブラウザは長時間リクエストが切れると同じ分析をもう一度投げる（page.js の fetchLongRunning）。
// 束ねないとOpusが二重に走り、画面に出る本文とディスクに保存される本文が別々の実行結果になる。
const jobCache = new Map();
const JOB_TTL_MS = 15 * 60 * 1000;

const RULES_BASE = `あなたは経験豊富な株式投資アナリストです。与えられた「事実サマリー（企業の一次情報を、数値の推移・変化点・最新の見通しに絞って忠実にまとめたもの）」を土台に、投資判断を述べます。数値の推移そのものは事実サマリー側に既にあるので、分析では繰り返しません。

【絶対に守るルール】
1. 会社の財務数値・事実は、提供された「事実サマリー」に書かれているものだけを使う。無い会社の数字は作らない・推測しない。
2. 数字の表や網羅的な数値の羅列はしない（それは事実サマリーの役割）。判断の根拠として必要な数字だけ、最小限を引用する。
3. 「事実（サマリーからの引用）」と「あなたの解釈・見立て（【所見】）」を分ける。サマリーに根拠が無いことは「サマリーからは判断できません」と明記する。
4. 確度が低い点は正直に述べる。断定より正確さを優先する。
5. 出典は〔資料名 P.x〕の形で書く。<cite> などのHTMLタグは使わない。

【投資妙味ランクの基準】
提供された事実サマリーの範囲だけで、会社の開示ベースの状態を相対評価します。
将来の成果を保証するものではありません。

[[RANK_RULES]]

【出力の形（厳守）】
下の見出しを、この順番で、過不足なく出します。**毎回まったく同じ構成**にしてください。
- 見出しの文言は1文字も変えない（記号・かっこを含む）。
- ここに無い見出しを足さない（「総合判断」「まとめ」「投資判断」などを勝手に作らない）。
- 冒頭にレポートのタイトル（# 見出し）や「承知しました」などの前置きを書かない。**最初の行は必ず「## 投資妙味ランク：」で始める**。
- 下に【分析者の視点】がある場合、それは文体と着眼点にだけ効かせ、この構成は変えない。
- 見出しの順番も入れ替えない。

（日本語・ですます調・簡潔に）

## 投資妙味ランク：A / B / C / D / 判定不能
（1行目でA・B・C・D・判定不能のいずれか1つを明示。
続けて次の2行を必ず入れる。
　「評価の型：◯◯型（この型として見た理由を一言）」
　仮説が渡されている場合のみ「仮説の確度：高／中／低／検証不能」
そのうえで、そのランクにした理由を事実サマリーの材料に結びつけて1〜2行。上の型ごとの基準に従う。
ランクは資料ベースの相対評価であり株価の割安割高は含まないことを一言添える。
利用者の方針で避ける型に該当する場合は「※この銘柄は方針上の避ける型（◯◯）に該当します」を必ず入れる。
「判定不能」を選んだ場合は、何の情報が足りないのか・どの資料を追加で見れば判断できるのかを必ず具体的に書く）[[THESIS_SECTION]]

## 総括
（結論から2〜3行。今どういう局面か、投資妙味の有無を端的に）

## 業界内での位置づけと市況
（同業・業界の中でこの会社がどこにいるか、そして今の市況がこの会社にとって追い風か逆風か。外部情報が使える設定のときは、競合・業界動向・マクロの市況を出典付きで書く〔媒体名・時期・可能ならURL〕。古い記事は時期を明記する。外部情報が使えない設定のときは「外部情報を使わない設定のため、業界内の比較と市況は行っていません」と1行だけ書く）

## ポテンシャル（こうなれば上がる）
（【所見】上振れにつながる条件・イベント。箇条書き2〜4点。事実サマリーの変化点や見通しと関連づける）

## リスク（こうなれば下がる）
（【所見】下振れ・悪化につながる要因。箇条書き2〜4点）

## この業種で特に見るべき数字
（まず、事実サマリーから判断できる業種・ビジネスモデルを一言で述べる。その業種で業績・株価を左右しやすい指標を2〜4個挙げ、なぜその業種でその指標が効くのかを一言添える〔例：小売なら既存店売上高・在庫、メーカーなら受注残・粗利率・稼働率、金融なら自己資本比率・与信費用、SaaSなら解約率・ARR〕。各指標について、今この会社がどの水準・どの方向かを事実サマリーの数値を引用して短くコメントする。該当数値がサマリーに無い指標は「サマリーには記載なし・次回要確認」と書く）

## 着眼点（次に確認すべきこと）
（今後フォローすべき数字・イベントを箇条書きで数点）`;

// 仮説が渡されているときだけ足す見出し。追認にならないよう、
// 反証と「確認できなかったこと」を必ず書かせる。
const THESIS_SECTION_MD = `

## 仮説の検証
（利用者の仮説を検証する。次の小見出しをこの順で必ず全部書く。
**確かめられる形に言い換えると**：仮説が成り立つ条件を、資料で確認できる形に言い換える（何がいくらなら成り立つか）
**支持する事実**：出典付きで挙げる
**反証する事実**：出典付きで挙げる。見つからなかった場合は「探したが見つからなかった」と書く。空欄にしない
**確認できなかった事実**：仮説の中心にある数字が開示されていないなど。1つ以上必ず挙げる
**仮説が崩れる条件**：何が分かったら見立てが間違いだったと言えるか）`;

// 仮説の有無でセクション構成が変わるので、そのつど組み立てる。
function buildRules(hasThesis) {
  return RULES_BASE
    .replace("[[RANK_RULES]]", RANK_RULES)
    .replace("[[THESIS_SECTION]]", hasThesis ? THESIS_SECTION_MD : "");
}

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

    const { companyName, summaries, documents, question, profile, external, stance, thesis } = await request.json();
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
    // 型ごとのランク基準と、仮説の検証。仮説が無ければ従来どおりの構成。
    const { block: stanceBlock, hasThesis } = buildStanceBlock({ stance, thesis });
    const RULES = buildRules(hasThesis);

    const profileBlock = (profile || "").trim()
      ? `\n\n【分析者の視点・重視する観点（この観点・スタイルで分析してください。ただし上の絶対ルールは厳守）】\n${profile.trim()}`
      : "";

    // 外部情報ONのとき：Web検索で業界・競合をリサーチし、分析コメントに織り込む。
    // 二層構造を守る＝「会社自身の事実は要約から／外部の話は出典付きで」。
    const externalBlock = external
      ? `\n\n【この分析ではWeb検索が使えます（外部リサーチ可・上のルール1の例外）】
- 検索できる先は次の公式・報道系サイトに限定されています: ${SOURCE_SUMMARY}
  （SNSの投稿・個人ブログ・まとめサイトは検索対象に入りません。これらを出典にしないでください。）
- 業界動向・競合他社・市況など、事実サマリーに無い情報はWeb検索で調べ、投資判断に織り込んでよい。同業との位置づけ（シェア・成長率・利益率の比較感）や、業界の追い風/逆風を積極的に補ってよい。
- ただし二層を厳守する：
  ・**会社自身の実績数値・見通し**は、必ず「事実サマリー」からのみ引く（外部の数字で上書きしない）。
  ・**外部（業界・競合）由来の記述**には、必ずその場に出典（媒体名・可能ならURL・時期）を添える。裏取りできない噂・古い情報は書かない。
- 外部情報は独立セクションに隔離せず、「総括」「ポテンシャル」「リスク」「着眼点」の中で、会社の実績と関連づけて自然に使う。ただし読み手が「これは外部の話」と分かるよう、出典で明示する。
- 「## 業界内での位置づけ」には、外部で調べた競合・業界の情報を出典付きで書く（見出しは固定。増やしも減らしもしない）。`
      : "";

    const system = `${RULES}${stanceBlock}${profileBlock}${externalBlock}\n\n【参照可能な要約は以下がすべてです】${block}`;
    const anthropic = new Anthropic({ apiKey });

    // 外部情報ON時はWeb検索ツール（サーバー側実行・出典付き）を渡す。
    // 参照先をドメインで縛る。「Xを見ないでください」と指示するのではなく、
    // そもそも検索結果に入らないようにする（allowed_domains）。
    // web_fetch も渡して、見つけた記事の本文まで読めるようにする。
    const tools = external
      ? [
          {
            type: "web_search_20260209",
            name: "web_search",
            max_uses: 8,
            allowed_domains: ALLOWED_DOMAINS,
          },
          {
            type: "web_fetch_20260209",
            name: "web_fetch",
            max_uses: 5,
            allowed_domains: ALLOWED_DOMAINS,
          },
        ]
      : undefined;

    async function runAnalysis() {
      // Web検索はサーバー側でループするため、上限に達すると stop_reason=pause_turn で返る。
      // その場合は会話を継ぎ足して再開する。
      // 重要：本文は「最後の応答」だけでなく毎ターン集める。
      // 中断前のターンに書かれた文章（＝先頭の「投資妙味ランク」など）が捨てられるのを防ぐ。
      const messages = [{ role: "user", content: userText }];
      const parts = [];
      for (let i = 0; i < 6; i++) {
        const response = await anthropic.messages.create({
          model: ANALYSIS_MODEL,
          max_tokens: 16000,
          system,
          messages,
          ...(tools ? { tools } : {}),
        });
        const turnText = response.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (turnText) parts.push(turnText);
        if (response.stop_reason !== "pause_turn") break;
        messages.push({ role: "assistant", content: response.content });
      }

      let analysis = parts.join("\n\n").trim();

      // ランクが本文に無いまま返ってくることが稀にある（検索での中断や指示の取りこぼし）。
      // 画面の要になる部分なので、その場で書き足させる（短い追加呼び出し1回）。
      if (analysis && !/投資妙味ランク\s*[：:]/.test(analysis)) {
        try {
          const fix = await anthropic.messages.create({
            model: ANALYSIS_MODEL,
            max_tokens: 700,
            system: `${buildRules(false)}\n\n【今回の依頼】上の基準に従い、「## 投資妙味ランク：」の行と、その理由（1〜2行）だけを出力してください。他の見出しや本文は書かないでください。`,
            messages: [
              {
                role: "user",
                content: `次の分析はあなたが書いたものです。この内容だけに基づいて、投資妙味ランクの見出し行と理由を出力してください。\n\n${analysis.slice(0, 60000)}`,
              },
            ],
          });
          const rankText = fix.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n")
            .trim();
          if (/投資妙味ランク\s*[：:]/.test(rankText)) {
            analysis = `${rankText}\n\n${analysis}`;
          }
        } catch {
          // 補完に失敗しても本体の分析は返す（画面には「記載が見つかりません」と出る）
        }
      }

      const outDir = path.join(getCompanyDir(company), "_分析");
      fs.mkdirSync(outDir, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 10);
      const mdPath = path.join(outDir, `${company}_分析_${stamp}.md`);
      fs.writeFileSync(
        mdPath,
        `# ${company} 分析（${stamp}）\n\n対象要約: ${included.join(" / ")}\n\n${analysis}\n`
      );
      return { analysis, mdPath };
    }

    // 同じ入力の分析が走っていれば、それを待って同じ本文を返す（二重実行・二重課金を防ぐ）。
    const jobKey = crypto
      .createHash("sha256")
      .update(
        [company, ANALYSIS_MODEL, userText, profile || "", external ? "web" : "no-web", block].join("\u0000")
      )
      .digest("hex");

    let job = jobCache.get(jobKey);
    const reused = Boolean(job);
    if (!job) {
      job = runAnalysis();
      jobCache.set(jobKey, job);
      job.then(
        () => {
          const t = setTimeout(() => jobCache.delete(jobKey), JOB_TTL_MS);
          if (typeof t.unref === "function") t.unref();
        },
        () => jobCache.delete(jobKey)
      );
    }
    const { analysis, mdPath } = await job;

    return Response.json({ analysis, analysisPath: mdPath, included, reused });
  } catch (e) {
    return Response.json({ error: `エラー: ${e.message}` }, { status: 500 });
  }
}
