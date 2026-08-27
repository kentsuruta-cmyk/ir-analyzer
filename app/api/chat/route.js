import Anthropic from "@anthropic-ai/sdk";
import crypto from "crypto";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_TOTAL_CHARS = 150000;

// 同じ質問が同時に来たら1回の呼び出しを共有する（接続が切れて投げ直されたときの二重課金を防ぐ）
const jobCache = new Map();
const JOB_TTL_MS = 10 * 60 * 1000;

const RULES = `あなたは株式投資の分析アシスタントです。ユーザーから提供された資料だけを根拠に回答します。

【絶対に守るルール】
1. 提供された資料に書かれていることだけを根拠にしてください。あなたの一般知識や記憶にある企業情報は一切使わないでください。
2. 数値・事実を述べるときは、必ず次の形式で出典と原文引用を添えてください。
   例）営業利益は前年同期比12.3%増の1,250百万円でした。
       〔出典: 2026年3月期 決算短信〕
       〔原文: 営業利益 1,250百万円（前年同期比 12.3％増）〕
3. 原文をそのまま抜き出せない情報は、述べてはいけません。
4. 資料に書かれていないことを聞かれたら、推測せず「提供された資料には記載がありません」と明記してください。何が不足しているかを一言添えてください。ただし否定する前に、下の【事実サマリー】【このアプリが出した分析】【添付ファイル】を必ず最後まで探してください。
5. 資料から計算して導いた数値は、必ず「（資料の数値から算出）」と明記し、計算に使った元の数値も示してください。
6. 資料の内容と、あなたの解釈・所見は明確に分けてください。解釈には「【所見】」という見出しを付けてください。
7. 確度が低い場合は、その旨を正直に述べてください。断定を避けることより、正確であることを優先してください。

【この画面に出ている「事実サマリー」「分析」について聞かれたとき】
- 事実サマリーと分析は、同じ一次資料からこのアプリが作ったものです。あなた自身の出力として扱い、根拠に使ってかまいません。
- 「分析に出てくるこの会社名は何？」のように、画面に表示されている記述について聞かれたら、まず事実サマリーと分析の本文をその語で探し、見つかった箇所を引用して答えてください。
- 見つかった場合に「そのようなことは述べていません」と否定してはいけません。ユーザーは実際に画面に出ている文章を読んでいます。
- 分析にあって一次資料に無い記述（Web検索で補った業界情報など）は、「分析で外部情報として触れている内容です」と断ったうえで答えてください。

【回答スタイル】
- 日本語で、結論から述べてください。
- 見出しと箇条書きで読みやすく整理してください。
- 冗長な前置きは不要です。`;

export async function POST(request) {
  try {
    const { documents, messages, summaries, analysis, external } = await request.json();

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || !apiKey.startsWith("sk-ant")) {
      return Response.json(
        {
          error:
            "APIキーが正しく設定されていません。.env.local に ANTHROPIC_API_KEY=sk-ant... の形で設定し、サーバーを再起動してください。",
        },
        { status: 500 }
      );
    }

    // 資料が未選択でも、事実サマリー・分析・添付ファイルのどれかがあれば答えられる
    const hasAttachment = (messages || []).some(
      (m) => Array.isArray(m.attachments) && m.attachments.length > 0
    );
    const hasMaterial =
      (documents && documents.length > 0) ||
      (Array.isArray(summaries) && summaries.some((s2) => s2 && s2.text)) ||
      (analysis || "").trim() ||
      hasAttachment;
    if (!hasMaterial) {
      return Response.json(
        { error: "参照する資料が選択されていません（資料を選ぶか、ファイルを添付してください）" },
        { status: 400 }
      );
    }

    let docBlock = "";
    const included = [];
    for (const doc of documents || []) {
      const block = `\n\n===== 資料: ${doc.label} =====\n出典URL: ${doc.url}\n\n${doc.text}\n===== 資料ここまで =====`;
      if (docBlock.length + block.length > MAX_TOTAL_CHARS) break;
      docBlock += block;
      included.push(doc.label);
    }

    // 画面に出ているものと同じ材料を渡す。
    // 以前は一次資料のテキストだけを渡していたため、事実サマリー・分析にしか
    // 出てこない固有名詞（取引先名など）を聞かれると「記載がありません」と答えてしまっていた。
    const summaryBlock = (Array.isArray(summaries) ? summaries : [])
      .filter((s2) => s2 && s2.text)
      .map((s2) => `\n\n===== 事実サマリー: ${s2.label || "事実サマリー"} =====\n${s2.text}\n===== ここまで =====`)
      .join("");

    const analysisBlock = (analysis || "").trim()
      ? `\n\n===== このアプリが出した分析（投資判断）=====\n${analysis.trim()}\n===== ここまで =====`
      : "";

    // 外部情報ONのとき：資料に無い一般情報（取引先がどんな会社か、業界動向など）を
    // Web検索で調べて答えてよい。ただし会社自身の数値は資料からのみ引く。
    const externalBlock = external
      ? `\n\n【この質問ではWeb検索が使えます（上のルール1の例外）】
- 資料に無い一般情報（取引先・親会社がどんな会社か、業界動向、競合の状況など）は、Web検索で調べて答えてよい。
- ただし二層を厳守する：
  ・**この会社自身の実績数値・見通し**は、必ず資料・事実サマリーからのみ引く（外部の数字で上書きしない）。
  ・**外部由来の記述**には、必ずその場に出典（媒体名・URL・時期）を添える。裏取りできない情報は書かない。
- 「資料には記載がありません」で終わらせず、外部で調べられることは調べてから、どこまでが資料でどこからが外部かを分けて答える。`
      : "";

    const system =
      `${RULES}${externalBlock}` +
      (summaryBlock ? `\n\n【事実サマリー（一次資料から作成済み）】${summaryBlock}` : "") +
      (analysisBlock ? `\n\n【このアプリが出した分析】${analysisBlock}` : "") +
      `\n\n【一次資料は以下がすべてです】${docBlock}`;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // 添付ファイル（PDF・画像・テキスト）を、その質問のcontentブロックとして渡す。
    // PDFと画像はモデルがそのまま読む。テキスト系は中身を展開して渡す。
    const toBlocks = (m) => {
      const atts = Array.isArray(m.attachments) ? m.attachments : [];
      if (m.role !== "user" || atts.length === 0) return { role: m.role, content: m.content };
      const blocks = [];
      for (const a of atts) {
        if (!a || !a.data) continue;
        const type = a.mediaType || "";
        if (type === "application/pdf") {
          blocks.push({
            type: "document",
            title: a.name || "添付PDF",
            source: { type: "base64", media_type: "application/pdf", data: a.data },
          });
        } else if (type.startsWith("image/")) {
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: type, data: a.data },
          });
        } else {
          const text = Buffer.from(a.data, "base64").toString("utf8").slice(0, MAX_TOTAL_CHARS);
          blocks.push({
            type: "text",
            text: `===== 添付ファイル: ${a.name || "file"} =====\n${text}\n===== ここまで =====`,
          });
        }
      }
      blocks.push({ type: "text", text: m.content });
      return { role: "user", content: blocks };
    };

    const jobKey = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          system,
          external: Boolean(external),
          messages: (messages || []).map((m) => ({
            role: m.role,
            content: m.content,
            atts: (m.attachments || []).map((a) => `${a.name}:${(a.data || "").length}`),
          })),
        })
      )
      .digest("hex");

    // Web検索は途中で stop_reason=pause_turn を返すので、会話を継ぎ足して再開しつつ
    // 本文は毎ターン集める（中断前に書かれた文章を捨てない）。
    const runChat = async () => {
      const tools = external
        ? [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }]
        : undefined;
      const convo = messages.map(toBlocks);
      const parts = [];
      for (let i = 0; i < 5; i++) {
        const res = await anthropic.messages.create({
          model: "claude-opus-5",
          max_tokens: 16000,
          system,
          messages: convo,
          ...(tools ? { tools } : {}),
        });
        const turnText = res.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (turnText) parts.push(turnText);
        if (res.stop_reason !== "pause_turn") break;
        convo.push({ role: "assistant", content: res.content });
      }
      return parts.join("\n\n").trim();
    };

    let job = jobCache.get(jobKey);
    if (!job) {
      job = runChat();
      jobCache.set(jobKey, job);
      job.then(
        () => {
          const t = setTimeout(() => jobCache.delete(jobKey), JOB_TTL_MS);
          if (typeof t.unref === "function") t.unref();
        },
        () => jobCache.delete(jobKey)
      );
    }
    const answer = await job;

    return Response.json({ answer, includedCount: included.length });
  } catch (e) {
    return Response.json({ error: `エラー: ${e.message}` }, { status: 500 });
  }
}
