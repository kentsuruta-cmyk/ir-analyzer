"use client";

import { useState, useEffect, useRef, useMemo } from "react";

const STORAGE_KEY = "ir-analyzer-documents";
const PROFILE_KEY = "ir-analyzer-profile";
const COMPANY_KEY = "ir-analyzer-company";
const TICKER_KEY = "ir-analyzer-ticker";
const MINFY_KEY = "ir-analyzer-min-fiscal-year";
// 要約・分析の結果。再読み込みで消えないようブラウザにも残す
const RESULT_KEY = "ir-analyzer-result";

const DEFAULT_PROFILE = `あなたはゴールドマン・サックスのトップアナリストです。ですます調で、結論から述べ、主張には必ず数値の根拠と理由を付けます。

まずこの会社の業種を見極め、その業種で重視される観点・指標に沿って分析してください。
・証券/投資銀行：収益構成（ウェルス/運用/ホールセール）、ROE、費用対収益比率、預り資産残高、自己資本規制比率。トレーディング頼みの一過性増益は割り引く。
・銀行：NIM、不良債権比率、自己資本比率（BIS/CET1）、貸出の伸び、与信費用。預金は負債だが低コスト調達なら強み。
・不動産：稼働率、NOI、含み益、有利子負債とLTV、開発パイプライン。
・製造業：売上・利益の推移と変動要因、営業CFと利益の整合性、セグメント採算、受注・在庫、設備投資。
・SaaS/ソフト：ARR・売上成長率、解約率、粗利率、顧客獲得効率、営業CF。
・上記以外：その業種で一般に重視される指標を自分で選び、理由を添えて分析する。

事実（要約からの引用）と、あなたの解釈【所見】を明確に分け、良し悪しの判断には必ず数値の根拠を添えてください。`;

const PRESET_QUESTIONS = [
  "業績のサマリーを教えて",
  "利益が変動した要因は？",
  "今期の会社見通しと進捗は？",
  "リスク・懸念点を挙げて",
];

// 保存済みPDFのパス（~/IR資料/{会社名}/...）から会社名を取り出す。
function deriveCompanyName(docs) {
  for (const d of docs) {
    if (d.savedPath) {
      const after = d.savedPath.split("/IR資料/")[1];
      if (after) return after.split("/")[0];
    }
  }
  return "";
}

// 要約・分析は1リクエストが数分かかることがあり、その間に接続が切れると
// ブラウザは "Failed to fetch"（HTTPステータスの無いネットワークエラー）を投げる。
// サーバー側は資料ごと・資料の組み合わせごとに結果をディスクにキャッシュしているので、
// 同じリクエストをもう一度投げれば済んだ分はスキップされ、続きから再開できる。
// そのため、ネットワークエラーのときだけ自動で投げ直す。
// （HTTPエラーは中身のあるレスポンスなので、そのまま呼び出し元へ返す）
// 分析APIは同じ入力なら実行中のものに相乗りして同じ本文を返すので（analyze-local の jobCache）、
// 投げ直しても二重にOpusが走ることはない。接続が切れやすい環境向けに回数を持たせている。
async function fetchLongRunning(url, options, { retries = 3, onRetry } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (e) {
      lastError = e;
      if (attempt < retries) onRetry?.(attempt + 1);
    }
  }
  throw new Error(
    `サーバーとの接続が切れました（${lastError?.message || "ネットワークエラー"}）。` +
      `ここまでの結果はパソコンに保存されているので、もう一度同じ操作をすると続きから再開できます。`
  );
}

// その資料がどの会社のものかを保存先パスから取り出す（未保存の資料は空文字）。
function companyOfDoc(doc) {
  if (!doc?.savedPath) return "";
  const after = doc.savedPath.split("/IR資料/")[1];
  return after ? after.split("/")[0] : "";
}

// 「標準セット」＝毎回これだけ見れば足りる資料の組み合わせ。
// 旧実装は収集した資料を全部チェック済みにしていたので、要らないものを
// 手で外す作業が発生していた。既定でこの組み合わせだけが選ばれた状態にする。
//
// 内訳:
//   1. 最新の決算短信          … 直近の実績と会社予想
//   2. 直近の通期決算短信      … 前期の着地（1と別物のときだけ）
//   3. 最新の決算説明資料      … 補助資料
//   4. 最新の質疑応答          … 経営陣の受け答え
//   5. 最新の説明会書き起こし  … 経営陣が自分の言葉で語る先行き
//   6. 最新の有価証券報告書    … 事業の中身・有報にしかない情報
//   7. 最新の中期経営計画      … 出している会社のみ
const STANDARD_SET_TYPES = [
  "決算短信",
  "決算説明資料",
  "質疑応答",
  "説明会書き起こし",
  "有価証券報告書",
  "中期経営計画",
];

// 決算期の新しさを数値化する。「2026年3月期」「2025年度」「第85期」を扱う。
// 同じ種別どうしの比較にしか使わないので、表記系統が混ざっても実害は出にくい。
function periodRank(fiscalYear, quarter) {
  const fy = fiscalYear || "";
  let year = null;
  const m1 = fy.match(/((?:19|20)\d{2})年\s*\d{1,2}\s*月期/);
  const m2 = fy.match(/((?:19|20)\d{2})\s*年度/);
  const m3 = fy.match(/第\s*(\d{1,3})\s*期/);
  if (m1) year = Number(m1[1]);
  else if (m2) year = Number(m2[1]) + 1;   // 2025年度 ≒ 2026年3月期
  else if (m3) year = 1900 + Number(m3[1]); // 第N期は別系統。同種別内の順序付けにだけ使う
  if (year === null) return -1;            // 決算期不明。並びの最後に回す
  const q = quarter === "通期" ? 4 : Number((quarter || "").match(/第(\d)/)?.[1] || 0);
  return year * 10 + q;
}

function isType(doc, type) {
  const t = doc.docType || "";
  // 「訂正決算短信」は訂正版なので標準セットには入れない
  return t === type;
}

// 種別ごとに最新の1件を返す。決算期が読めないものは、資料棚の並び順（＝IRページの
// 掲載順、通常は新しい順）で先に出てきたものを採る。
function latestOfType(docs, type) {
  const cands = docs.filter((d) => d.savedPath && isType(d, type));
  if (!cands.length) return null;
  return cands
    .map((d, i) => ({ d, i, rank: periodRank(d.fiscalYear, d.quarter) }))
    .sort((a, b) => b.rank - a.rank || a.i - b.i)[0].d;
}

function pickStandardSet(docs) {
  const picked = [];
  const push = (d) => {
    if (d && !picked.some((p) => p.url === d.url)) picked.push(d);
  };

  // 1. 最新の決算短信
  const latestTanshin = latestOfType(docs, "決算短信");
  push(latestTanshin);

  // 2. 直近の「通期」決算短信。最新が四半期なら、前期の着地を押さえるために足す。
  if (latestTanshin && latestTanshin.quarter !== "通期") {
    const fullYear = docs
      .filter((d) => d.savedPath && isType(d, "決算短信") && d.quarter === "通期")
      .map((d, i) => ({ d, i, rank: periodRank(d.fiscalYear, d.quarter) }))
      .sort((a, b) => b.rank - a.rank || a.i - b.i)[0];
    push(fullYear?.d);
  }

  // 3〜7
  for (const type of ["決算説明資料", "質疑応答", "説明会書き起こし", "有価証券報告書", "中期経営計画"]) {
    push(latestOfType(docs, type));
  }

  return picked;
}

// 全自動フローも標準セットを使う（旧 pickCoreDocs の置き換え）
function pickCoreDocs(docs) {
  return pickStandardSet(docs);
}

// 保存済みファイルの時刻を「8/21 14:55」の形にする
function formatSavedAt(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}

// 見出しの内容からアイコンを選ぶ（視認性UP）
function iconForHeading(h) {
  if (/推移|差分|比較/.test(h)) return "📊";
  if (/最新|実績|業績|見通し/.test(h)) return "📈";
  if (/ポテンシャル|上がる|強気|成長/.test(h)) return "🚀";
  if (/リスク|下がる|懸念|悪化/.test(h)) return "⚠️";
  if (/着眼|確認|フォロー/.test(h)) return "🔍";
  if (/業界|競合|位置/.test(h)) return "🏭";
  if (/セグメント|事業/.test(h)) return "🧩";
  return "•";
}

// 投資妙味ランクの見え方（色・既定の言い回し）
const RANK_STYLES = {
  A: { tone: "a", note: "積極的に妙味あり" },
  B: { tone: "b", note: "妙味あり・条件付き" },
  C: { tone: "c", note: "中立・様子見" },
  D: { tone: "d", note: "見送り・要警戒" },
  判定不能: { tone: "na", note: "情報不足・判断保留" },
};

// 分析Markdownから「投資妙味ランク」の行を取り出し、本文から切り離す。
// 見出し（## 投資妙味ランク：B（…））でも、本文中の1行でも拾えるようにする。
// 戻り値の rest は、ランク部分を取り除いた残りの本文（バッジと二重表示しないため）。
function extractRank(text) {
  const lines = (text || "").split("\n");
  const idx = lines.findIndex((l) => /投資妙味ランク\s*[：:]/.test(l));
  if (idx < 0) return { rank: null, rest: (text || "").trim() };

  const line = lines[idx];
  const after = line
    .split(/[：:]/)
    .slice(1)
    .join("：")
    .replace(/[*#]/g, "")
    .trim();

  // 出力テンプレート（A / B / C / D / 判定不能）をそのまま書いてきた場合はランク無し扱い
  if (/A\s*\/\s*B/.test(after)) return { rank: null, rest: (text || "").trim() };

  const m = after.match(/判定不能|[ABCD]/);
  if (!m) return { rank: null, rest: (text || "").trim() };

  const letter = m[0];
  const style = RANK_STYLES[letter] || { tone: "na", note: "" };
  const paren = after.match(/[（(]([^）)]+)[）)]/);

  // ランクの理由（同じ行の続き＋、見出しならその節の本文、1行形式なら次の空行まで）
  let tail = after.slice(after.indexOf(letter) + letter.length);
  if (paren) tail = tail.replace(paren[0], "");
  tail = tail.replace(/^[\s：:、。・\-—ー]+/, "").trim();

  const isHeading = /^\s*#{1,4}\s/.test(line);
  let end = idx + 1;
  while (end < lines.length) {
    if (/^\s*#{1,4}\s/.test(lines[end])) break;
    if (!isHeading && !lines[end].trim()) break;
    end++;
  }
  const reason = [tail, lines.slice(idx + 1, end).join("\n").trim()]
    .filter(Boolean)
    .join("\n");
  const rest = [...lines.slice(0, idx), ...lines.slice(end)].join("\n").trim();

  return {
    rank: { letter, tone: style.tone, label: paren ? paren[1] : style.note, reason },
    rest,
  };
}

// 投資判断の先頭に出す、一目でわかるランクバッジ
function RankBadge({ rank }) {
  if (!rank) {
    return (
      <div className="rank-card rank-none">
        <div className="rank-mark rank-mark-sm">—</div>
        <div className="rank-body">
          <div className="rank-kicker">投資妙味ランク</div>
          <div className="rank-label">記載が見つかりませんでした</div>
          <p className="rank-reason">
            分析本文にランクの行がありません。もう一度分析すると出ることがあります。
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className={`rank-card rank-${rank.tone}`}>
      <div className={`rank-mark${rank.letter.length > 1 ? " rank-mark-sm" : ""}`}>
        {rank.letter}
      </div>
      <div className="rank-body">
        <div className="rank-kicker">投資妙味ランク</div>
        <div className="rank-label">{rank.label}</div>
        {rank.reason && (
          <div className="rank-reason">
            <RichBody heading={null} lines={rank.reason.split("\n")} />
          </div>
        )}
      </div>
    </div>
  );
}

// **太字** をReactに変換
function renderInline(s) {
  // 分析本文にときどき混ざる <cite>…</cite> はタグだけ落として中身を残す
  return (s || "").replace(/<\/?cite[^>]*>/g, "").split(/(\*\*[^*]+\*\*)/g).map((p, i) => {
    const m = p.match(/^\*\*([^*]+)\*\*$/);
    return m ? <strong key={i}>{m[1]}</strong> : <span key={i}>{p}</span>;
  });
}

// 「| 売上高 | 100 |」形式の行をセルに分解
function parsePipeRow(line) {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}
// Markdown表の区切り行（|---|---:|）
const isDividerRow = (line) => /^[\s|:-]+$/.test(line) && line.includes("-");

// セルを「数値」と「〔出典〕」に分ける。
// 要約は数値ごとに出典を強制しているので、そのまま表に入れると1セルが
// 数値より出典のほうが長くなり、横スクロールしないと一覧できなくなる。
// 既定では数値だけを並べ、出典は必要なときだけ開く。
function splitCell(text) {
  const sources = [];
  const value = (text || "")
    .replace(/〔[^〕]*〕/g, (m) => {
      sources.push(m);
      return "";
    })
    .replace(/\s+/g, " ")
    .trim();
  // 「6,128百万円（前年同期比38.5％）」→ 主数値と補足に分ける。
  // 主数値だけを折り返し禁止にすれば、列幅は数値の長さで決まり、
  // 補足と出典は下に回り込むので横スクロールが要らなくなる。
  const m = value.match(/^([^（(]+?)\s*([（(].*)$/);
  return { value, main: m ? m[1].trim() : value, note: m ? m[2].trim() : "", sources };
}

// 1セクションの本文を、箇条書き・段落・（推移などは罫線付きの表）に整形
function RichBody({ heading, lines }) {
  const [showSources, setShowSources] = useState(false);
  // 表として描くかどうかは、見出しの文言ではなく本文の中身で決める。
  // 旧：見出しに「推移／差分／比較」が含まれるときだけ表にしていたため、
  //     「通期（連結）」（＝会社予想が載る表）や「四半期単独の売上高・営業利益」が
  //     生の | 記法のまま段落として出ていた。
  const pipeRows = lines.filter((l) => ((l || "").match(/\|/g) || []).length >= 2);
  const legacyHeading = Boolean(heading && /推移|差分|比較/.test(heading));
  const isTable = pipeRows.length >= 2 || legacyHeading;
  if (isTable) {
    const out = [];
    let rows = null;
    let sawTable = false;
    const flushTable = () => {
      if (rows && rows.length) {
        const [head, ...body] = rows;
        sawTable = true;
        const cells = body.map((r) => r.map(splitCell));
        const hasSources = cells.some((r) => r.some((c) => c.sources.length > 0));
        out.push(
          <div key={`t-${out.length}`} className="rich-table-block">
            {hasSources && (
              <label className="rt-toggle">
                <input
                  type="checkbox"
                  checked={showSources}
                  onChange={(e) => setShowSources(e.target.checked)}
                />
                出典を表示する
              </label>
            )}
            <div className="rich-table-wrap">
              <table className="rich-table">
                <thead>
                  <tr>
                    {head.map((c, i) => (
                      <th key={i}>{renderInline(splitCell(c).value)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cells.map((r, ri) => (
                    <tr key={ri}>
                      {r.map((c, ci) =>
                        ci === 0 ? (
                          // 指標名は普通に折り返す
                          <td key={ci} className="rt-label">
                            {renderInline(c.value)}
                          </td>
                        ) : (
                          <td key={ci} className="rt-num">
                            <span className="rt-val">
                              {/* 「＋1,695百万円、69.4％」のような値は区切り記号の後ろで折り返す。
                                  短い塊（数値）は途中で切れないよう保護し、
                                  「売上286百万円増加／営業利益166百万円増加」のような
                                  長い説明文は普通に折り返させる（列幅が膨らむのを防ぐ）。 */}
                              {(c.main.match(/[^、→／/]+[、→／/]?/g) || [c.main]).map((tok, ti) => (
                                <span key={ti} className={tok.length <= 12 ? "rt-tok" : undefined}>
                                  {tok}
                                </span>
                              ))}
                            </span>
                            {c.note && <span className="rt-note">{c.note}</span>}
                            {showSources && c.sources.length > 0 && (
                              <span className="rt-src">{c.sources.join(" ")}</span>
                            )}
                          </td>
                        )
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      }
      rows = null;
    };
    // 表と箇条書きが同じ節に混ざることがあるので、箇条書きもここで拾う
    let list = null;
    const flushList = () => {
      if (list) {
        out.push(
          <ul key={`ul-${out.length}`} className="rich-ul">
            {list}
          </ul>
        );
        list = null;
      }
    };
    lines.forEach((raw, idx) => {
      const line = (raw || "").trim();
      // 空行とコードフェンスは表の区切りとして扱う
      if (!line || line.startsWith("```")) {
        flushTable();
        flushList();
        return;
      }
      if (line.includes("|")) {
        flushList();
        if (isDividerRow(line)) return;
        if (!rows) rows = [];
        rows.push(parsePipeRow(line));
        return;
      }
      flushTable();
      const b = line.match(/^\s*(?:[-*・•]|\d+[.)])\s+(.*)/);
      if (b) {
        if (!list) list = [];
        list.push(<li key={idx}>{renderInline(b[1])}</li>);
        return;
      }
      flushList();
      out.push(
        <p key={idx} className="rich-p">
          {renderInline(line)}
        </p>
      );
    });
    flushTable();
    flushList();
    // 旧形式（半角スペースで桁揃え）の要約は、従来どおり等幅で表示する。
    // 中身から表と判定した節（pipeRows あり）は対象外。
    if (!sawTable && legacyHeading && pipeRows.length < 2) {
      const raw = lines.join("\n").replace(/^\n+|\n+$/g, "");
      // 中身が無い見出し（「## 数値の推移」など、下に ### が続くだけの節）で
      // 空の枠が出ないようにする
      if (!raw.trim()) return null;
      return (
        <pre className="rich-table-pre">
          {raw}
        </pre>
      );
    }
    return <>{out}</>;
  }
  const out = [];
  let list = null;
  const flush = () => {
    if (list) {
      out.push(
        <ul key={`ul-${out.length}`} className="rich-ul">
          {list}
        </ul>
      );
      list = null;
    }
  };
  lines.forEach((raw, idx) => {
    const line = (raw || "").replace(/\s+$/, "");
    if (!line.trim()) {
      flush();
      return;
    }
    const b = line.match(/^\s*(?:[-*・•]|\d+[.)])\s+(.*)/);
    if (b) {
      if (!list) list = [];
      list.push(<li key={idx}>{renderInline(b[1])}</li>);
    } else {
      flush();
      out.push(
        <p key={idx} className="rich-p">
          {renderInline(line)}
        </p>
      );
    }
  });
  flush();
  return <>{out}</>;
}

// 要約・分析の生Markdownを、見出し付きの読みやすい形に整形して表示
function RichText({ text }) {
  const lines = (text || "").split("\n");
  const blocks = [];
  let current = { heading: null, body: [] };
  for (const line of lines) {
    const h = line.match(/^\s*#{1,4}\s+(.*)/);
    if (h) {
      blocks.push(current);
      current = { heading: h[1].trim(), body: [] };
    } else {
      current.body.push(line);
    }
  }
  blocks.push(current);

  return (
    <div className="rich">
      {blocks.map((b, i) =>
        !b.heading && b.body.join("").trim() === "" ? null : (
          <div key={i} className="rich-block">
            {b.heading && (
              <h4 className="rich-h">
                <span className="rich-h-icon">{iconForHeading(b.heading)}</span>
                {b.heading}
              </h4>
            )}
            <RichBody heading={b.heading} lines={b.body} />
          </div>
        )
      )}
    </div>
  );
}

// ── 業績テーブル ───────────────────────────────────────────────
// LLMにMarkdownの表を書かせて画面側で緩くパースする方式は、崩れると罫線の無い
// 塊になって読めなかった。ここは構造化出力(JSON)を受け取って組み立てるので、
// 列がずれることも罫線が消えることもない。

function fmtSigned(n) {
  if (n == null || Number.isNaN(n)) return "";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "±";
  return `${sign}${Math.abs(n).toFixed(1)}%`;
}

// 実績同士を比べて増減率を出す（会社予想は実績と混ぜない）
function changeRate(curr, prev) {
  if (curr == null || prev == null || prev === 0) return null;
  return ((curr - prev) / Math.abs(prev)) * 100;
}

// 「2027年3月期」から年の数字だけ取り出す。年度表記が来たときの保険も入れる。
function fyNumber(fiscalYear) {
  const m = (fiscalYear || "").match(/((?:19|20)\d{2})\s*年\s*\d{1,2}\s*月期/);
  if (m) return Number(m[1]);
  const n = (fiscalYear || "").match(/((?:19|20)\d{2})\s*年度/);
  if (n) return Number(n[1]) + 1;   // 2026年度 ≒ 2027年3月期
  return null;
}

// 保存済みの古い業績データには fiscal_year / quarter_label が無い。
// ラベル（例「2026年8月期3Q累計」「2027年3月期(会社予想)」）から補完して、
// 作り直さなくても前年同期比が出るようにする。
function fillPeriodFields(p) {
  if (p.fiscal_year && p.quarter_label) return p;
  const label = p.label || "";
  const fyMatch = label.match(/((?:19|20)\d{2}\s*年\s*\d{1,2}\s*月期)/);
  const nendo = label.match(/((?:19|20)\d{2})\s*年度/);
  const fiscal_year = p.fiscal_year || (fyMatch ? fyMatch[1].replace(/\s/g, "") : nendo ? `${Number(nendo[1]) + 1}年3月期` : "");

  let quarter_label = p.quarter_label;
  if (!quarter_label) {
    const q = label.match(/(?:第\s*([1-4])\s*四半期|([1-4])\s*Q)/i);
    quarter_label = q ? `${q[1] || q[2]}Q` : "通期";
  }
  const is_cumulative =
    p.is_cumulative != null ? p.is_cumulative : quarter_label === "通期" || /累計/.test(label);

  return { ...p, fiscal_year, quarter_label, is_cumulative };
}

// 前年の同じ四半期を探す。四半期と通期が混ざった表でも、
// 「1Qは前年の1Q」「通期は前年の通期」と正しく突き合わせるための関数。
// 旧実装はリスト上でひとつ前の実績と比べていたので、
// 「2027年3月期1Q」を「2026年3月期通期」と比べてしまう並びが起きえた。
function findSameQuarterPrevYear(periods, p) {
  const y = fyNumber(p.fiscal_year);
  if (y == null || !p.quarter_label) return null;

  const prevYear = periods.filter(
    (q) => !q.is_forecast && q.quarter_label === p.quarter_label && fyNumber(q.fiscal_year) === y - 1
  );
  if (prevYear.length === 0) return null;

  // 累計/単独まで一致するものを優先する。
  // ただし資料によって「第2四半期累計」「中間期」など表記が揺れるので、
  // 完全一致が無ければ同じ四半期であることだけを条件に拾う（比較先を見失わせない）。
  return prevYear.find((q) => q.is_cumulative === p.is_cumulative) || prevYear[0];
}

// 最新の実績を「前年の同じ四半期」と比べて、伸びているかを矢印1文字で表す。
// Kenがいちばん見たい部分。前年同期が見つからないときは比較しない（無理に隣と比べない）。
function yoyOf(cells, periods) {
  const actuals = periods.filter((p) => !p.is_forecast);
  for (let i = actuals.length - 1; i >= 0; i--) {
    const p = actuals[i];
    const cur = cells.find((c) => c.period_label === p.label);
    if (!cur || cur.numeric_million_yen == null) continue;
    const prevPeriod = findSameQuarterPrevYear(periods, p);
    if (!prevPeriod) continue;
    const prev = cells.find((c) => c.period_label === prevPeriod.label);
    if (!prev || prev.numeric_million_yen == null) continue;
    const r = changeRate(cur.numeric_million_yen, prev.numeric_million_yen);
    if (r == null) continue;
    const mark = r >= 5 ? "↗" : r <= -5 ? "↘" : "→";
    const cls = r >= 5 ? "trend-up" : r <= -5 ? "trend-down" : "trend-flat";
    return { mark, cls, rate: r, from: prevPeriod.label, to: p.label };
  }
  return null;
}

function PerformanceTable({ data }) {
  const [showSources, setShowSources] = useState(false);
  if (!data || !data.periods?.length || !data.rows?.length) return null;

  const { rows, company_view: view = [], forecast_revision: rev, notes = [] } = data;
  // 古い保存データでも前年同期比が出るように、足りない項目をラベルから補う
  const periods = data.periods.map(fillPeriodFields);

  return (
    <div className="perf">
      <div className="perf-head">
        <strong className="perf-title">📈 業績の推移と会社予想</strong>
        <label className="perf-toggle">
          <input
            type="checkbox"
            checked={showSources}
            onChange={(e) => setShowSources(e.target.checked)}
          />
          出典を表示
        </label>
      </div>

      <div className="perf-scroll">
        <table className="perf-table">
          <thead>
            <tr>
              <th className="perf-metric-head">指標</th>
              {periods.map((p) => (
                <th key={p.label} className={p.is_forecast ? "perf-forecast-head" : undefined}>
                  {p.label}
                  {p.is_forecast && <span className="perf-badge">会社予想</span>}
                </th>
              ))}
              <th className="perf-trend-head">前年同期比<span className="perf-badge-sub">最新実績</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const t = yoyOf(row.cells, periods);
              return (
                <tr key={row.metric}>
                  <th scope="row" className="perf-metric">{row.metric}</th>
                  {periods.map((p, pi) => {
                    const c = row.cells.find((x) => x.period_label === p.label);
                    if (!c) return <td key={p.label} className="perf-empty">—</td>;

                    // 前年の同じ四半期と比べて色を付ける（予想は色を付けない）。
                    // 隣の列と比べると、1Qと通期のように性質の違う期を比べてしまう。
                    let rate = null;
                    if (!p.is_forecast) {
                      const prevPeriod = findSameQuarterPrevYear(periods, p);
                      const prevCell = prevPeriod
                        ? row.cells.find((x) => x.period_label === prevPeriod.label)
                        : null;
                      rate = changeRate(c.numeric_million_yen, prevCell?.numeric_million_yen);
                    }
                    const cls = [
                      "perf-num",
                      p.is_forecast ? "perf-forecast" : "",
                      rate == null ? "" : rate > 0 ? "cell-up" : rate < 0 ? "cell-down" : "",
                    ].filter(Boolean).join(" ");

                    return (
                      <td key={p.label} className={cls}>
                        <span className="perf-val">{c.display}</span>
                        {c.yoy_text && <span className="perf-yoy">{c.yoy_text}</span>}
                        {!c.yoy_text && rate != null && (
                          <span className="perf-yoy perf-calc" title="前年同期との比較（原文に記載が無いため、この画面で計算した値）">
                            前年同期 {fmtSigned(rate)}
                          </span>
                        )}
                        {showSources && c.source && <span className="perf-src">{c.source}</span>}
                      </td>
                    );
                  })}
                  <td
                    className={`perf-trend ${t ? t.cls : ""}`}
                    title={t ? `${t.from} → ${t.to}` : "前年の同じ四半期が資料に無いため比較できません"}
                  >
                    {t ? (
                      <>
                        <span className="trend-mark">{t.mark}</span>
                        <span className="trend-rate">{fmtSigned(t.rate)}</span>
                        <span className="trend-from">{t.to} vs 前年</span>
                      </>
                    ) : (
                      <span style={{ color: "#cbd5e1" }}>—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {rev && rev.direction && rev.direction !== "記載なし" && (
        <div className={`perf-rev rev-${rev.direction}`}>
          <strong>通期予想：{rev.direction}</strong>
          {rev.quote && <span className="perf-rev-quote">「{rev.quote}」</span>}
          {rev.source && <span className="perf-src">{rev.source}</span>}
        </div>
      )}

      {view.length > 0 && (
        <div className="perf-view">
          <div className="perf-view-title">会社自身はこの数字をどう見ているか</div>
          <ul className="perf-view-list">
            {view.map((v, i) => (
              <li key={i}>
                <span className={`stance stance-${v.stance}`}>{v.stance}</span>
                <span className="perf-view-topic">{v.topic}</span>
                <span className="perf-view-quote">「{v.quote}」</span>
                {v.source && <span className="perf-src">{v.source}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {notes.length > 0 && (
        <ul className="perf-notes">
          {notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      )}
    </div>
  );
}

// ── テクニカル（エントリー位置の足切り）─────────────────────────
// 「良い会社でも、伸び切ったところでは買わない」ための位置確認。
// 売買推奨ではなく、移動平均乖離とボリンジャーバンドのσ位置を見せるだけ。
function yen(n) {
  if (n == null) return "—";
  return Math.round(n).toLocaleString();
}
function pct(n) {
  if (n == null) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}
function devClass(n) {
  if (n == null) return "";
  if (n >= 25) return "dev-hot";
  if (n >= 15) return "dev-warm";
  if (n <= -10) return "dev-cool";
  return "";
}
function sigmaClass(n) {
  if (n == null) return "";
  if (n >= 2.5) return "dev-hot";
  if (n >= 2.0) return "dev-warm";
  if (n <= -2.0) return "dev-cool";
  return "";
}

function TechnicalPanel({ data }) {
  if (!data?.technical) return null;
  const { technical: t, name, code, matchedBy } = data;
  const { weekly: w, monthly: m, judgement: j, range52w: r } = t;
  const levelCls = j.level === 2 ? "tech-stop" : j.level === 1 ? "tech-warn" : "tech-ok";

  // 週足は13/26週、月足は12/24ヶ月と本数が違うので、期間は行ごとに出す。
  // ヘッダーに固定で書くと、月足の行に週足の本数が出てしまう。
  const row = (label, unit, a) => (
    <tr>
      <th scope="row" className="tech-rowhead">
        {label}
        <span className="tech-rowsub">{a.maShortPeriod}{unit} / {a.maLongPeriod}{unit}</span>
      </th>
      <td>{yen(a.price)}</td>
      <td>{yen(a.maShort)}<span className="tech-cellsub">{a.maShortPeriod}{unit}</span></td>
      <td className={devClass(a.deviationShortPct)}>{pct(a.deviationShortPct)}</td>
      <td>{yen(a.maLong)}<span className="tech-cellsub">{a.maLongPeriod}{unit}</span></td>
      <td className={devClass(a.deviationLongPct)}>{pct(a.deviationLongPct)}</td>
      <td className={sigmaClass(a.bb?.position)}>
        {a.bb?.position == null ? "—" : `${a.bb.position > 0 ? "+" : ""}${a.bb.position.toFixed(2)}σ`}
      </td>
      <td className="tech-band">
        {a.bb ? `${yen(a.bb.sigma2[0])} 〜 ${yen(a.bb.sigma2[1])}` : "—"}
      </td>
    </tr>
  );

  return (
    <div className="tech">
      <div className="perf-head">
        <strong className="perf-title">📉 いま買う位置か（週足・月足）</strong>
        <span className="tech-meta">
          {name}（{code}）／終値 {yen(t.price)}円 @{t.asOf}
          {matchedBy ? `／銘柄特定: ${matchedBy}` : ""}
        </span>
      </div>

      <div className={`tech-verdict ${levelCls}`}>
        <div className="tech-verdict-label">{j.verdict}</div>
        <ul className="tech-reasons">
          {j.reasons.map((x, i) => <li key={i}>{x}</li>)}
        </ul>
      </div>

      <div className="perf-scroll">
        <table className="perf-table tech-table">
          <thead>
            <tr>
              <th>足</th>
              <th>終値</th>
              <th>短期の移動平均</th>
              <th>乖離</th>
              <th>長期の移動平均</th>
              <th>乖離</th>
              <th>BB位置</th>
              <th>±2σの範囲</th>
            </tr>
          </thead>
          <tbody>
            {row("週足", "週", w)}
            {row("月足", "ヶ月", m)}
          </tbody>
        </table>
      </div>

      {j.pullbackTargets?.length > 0 && j.level > 0 && (
        <div className="tech-targets">
          <span className="tech-targets-label">押し目の目安</span>
          {j.pullbackTargets.map((x, i) => (
            <span key={i} className="tech-target">
              {x.label} <b>{yen(x.value)}円</b>
            </span>
          ))}
        </div>
      )}

      <div className="tech-range">
        直近1年のレンジ: {yen(r.low)} 〜 {yen(r.high)}円
        （現在はレンジの{Math.round(((t.price - r.low) / (r.high - r.low)) * 100)}%の位置）
      </div>
      <p className="tech-note">
        株価データ: J-Quants（分割調整後の終値）。移動平均とボリンジャーバンド（20本・±2σ）から
        位置を機械的に判定しているだけで、売買の推奨ではありません。
      </p>
    </div>
  );
}

export default function Home() {
  const [urls, setUrls] = useState(["", "", "", "", "", ""]);  const [documents, setDocuments] = useState([]);
  const [selected, setSelected] = useState({});
  const [notes, setNotes] = useState([]);
  const [error, setError] = useState("");

  const [companyName, setCompanyName] = useState("");
  const [tickerCode, setTickerCode] = useState("");
  // 取り込む決算期の下限（西暦）。空なら制限なし。古い資料で枠が埋まるのを防ぐ。
  const [minFiscalYear, setMinFiscalYear] = useState(String(new Date().getFullYear() - 3));
  const [collectingLocal, setCollectingLocal] = useState(false);
  const [savedDir, setSavedDir] = useState("");

  const [summarizing, setSummarizing] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [summaries, setSummaries] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [metricsBusy, setMetricsBusy] = useState(false);
  const [technical, setTechnical] = useState(null);
  const [technicalBusy, setTechnicalBusy] = useState(false);
  const [technicalError, setTechnicalError] = useState("");
  const [codeChoices, setCodeChoices] = useState([]);
  const [analysis, setAnalysis] = useState("");
  // 表示中の分析が「保存済みファイルから復元したもの」のときの保存時刻
  const [savedAt, setSavedAt] = useState("");
  const [restoring, setRestoring] = useState(false);
  const autoRestoredFor = useRef("");

  const [autoRunning, setAutoRunning] = useState(false);
  const [autoStage, setAutoStage] = useState("");
  const [analysisProfile, setAnalysisProfile] = useState(DEFAULT_PROFILE);
  const [relabeling, setRelabeling] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [useExternal, setUseExternal] = useState(true);

  const [messages, setMessages] = useState([]);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  // 質問に添えるファイル（PDF・画像・テキスト）
  const [attachments, setAttachments] = useState([]);
  const [attachError, setAttachError] = useState("");
  const fileInputRef = useRef(null);
  const [loaded, setLoaded] = useState(false);

  const bottomRef = useRef(null);

  // 起動時にブラウザ保存から復元
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        setDocuments(parsed);
        const init = {};
        parsed.forEach((d) => (init[d.id] = true));
        setSelected(init);
      }
      const savedProfile = localStorage.getItem(PROFILE_KEY);
      if (savedProfile != null) setAnalysisProfile(savedProfile);
      const savedCompany = localStorage.getItem(COMPANY_KEY);
      if (savedCompany) setCompanyName(savedCompany);
      const savedTicker = localStorage.getItem(TICKER_KEY);
      if (savedTicker) setTickerCode(savedTicker);
      const savedMinFy = localStorage.getItem(MINFY_KEY);
      if (savedMinFy != null) setMinFiscalYear(savedMinFy);
      // 前回の要約・分析（同じ会社のものだけ戻す）
      const savedResult = localStorage.getItem(RESULT_KEY);
      if (savedResult) {
        const r = JSON.parse(savedResult);
        if (r && r.company && r.company === (savedCompany || "")) {
          if (Array.isArray(r.summaries)) setSummaries(r.summaries);
          if (r.analysis) setAnalysis(r.analysis);
          if (r.savedAt) setSavedAt(r.savedAt);
        }
      }
    } catch {}
    setLoaded(true);
  }, []);

  // 分析プロファイル・会社名・証券コードの保存
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(PROFILE_KEY, analysisProfile);
      localStorage.setItem(COMPANY_KEY, companyName);
      localStorage.setItem(TICKER_KEY, tickerCode);
      localStorage.setItem(MINFY_KEY, minFiscalYear);
    } catch {}
  }, [analysisProfile, companyName, tickerCode, minFiscalYear, loaded]);

  // 要約・分析の結果もブラウザに保存（再読み込み・ホットリロードで消えないように）
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(
        RESULT_KEY,
        JSON.stringify({ company: companyName, summaries, analysis, savedAt })
      );
    } catch {}
  }, [summaries, analysis, savedAt, companyName, loaded]);

  // 画面に結果が無いときは、パソコンに保存済みの最新の分析を自動で開く
  useEffect(() => {
    if (!loaded) return;
    const company = companyName.trim();
    if (!company || analysis || autoRestoredFor.current === company) return;
    autoRestoredFor.current = company;
    loadSaved(company, { silent: true });
  }, [companyName, analysis, loaded]);

  // 変更のたびにブラウザに保存
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(documents));
    } catch {
      setError("保存容量の上限に達しました。不要な資料を削除してください。");
    }
  }, [documents, loaded]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, asking]);

  function updateUrl(index, value) {
    const next = [...urls];
    next[index] = value;
    setUrls(next);
  }

  // 収集リクエスト。会社名の変え忘れが疑われるとサーバーが409で止めるので、
  // その場合だけ確認して、了解が得られたら同じ内容を confirm 付きで投げ直す。
  async function requestCollect() {
    const body = { companyName, tickerCode, urls, minFiscalYear };
    let res = await fetch("/api/collect-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let data = await res.json();
    if (!res.ok && data.needsConfirm === "differentSite") {
      const ok = window.confirm(
        `${data.error}\n\nこのまま「${companyName}」のフォルダに取り込みますか？\n` +
          `別の会社なら「キャンセル」を押し、「新しい会社を始める」で切り替えてください。`
      );
      if (!ok) {
        throw new Error(
          "取り込みを中止しました。「新しい会社を始める（全部クリア）」を押してから、会社名とURLを入れ直してください。"
        );
      }
      res = await fetch("/api/collect-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, confirmDifferentSite: true }),
      });
      data = await res.json();
    }
    return { res, data };
  }

  async function handleCollectLocal() {
    setCollectingLocal(true);
    setError("");
    setNotes([]);

    try {
      const { res, data } = await requestCollect();
      if (data.notes) setNotes(data.notes);
      if (!res.ok) throw new Error(data.error || "収集に失敗しました");

      setSavedDir(data.savedDir || "");

      const existingUrls = new Set(documents.map((d) => d.url));
      const fresh = data.documents.filter((d) => !existingUrls.has(d.url));

      const merged = [...documents, ...fresh];
      setDocuments(merged);
      // 旧実装は取り込んだ資料を全部チェック済みにしていたので、要らないものを
      // 手で外す作業が残っていた。標準セットだけを選んだ状態で渡す。
      const std = new Set(pickStandardSet(merged).map((d) => d.id));
      setSelected(() => {
        const next = {};
        merged.forEach((d) => (next[d.id] = std.has(d.id)));
        return next;
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setCollectingLocal(false);
    }
  }

  function toggle(id) {
    setSelected({ ...selected, [id]: !selected[id] });
  }

  // 手元のPDFを資料棚に足す。
  // IRサイトに載っていない資料（証券会社レポート、説明会の書き起こしなど）を
  // あとから何度でも足せるようにするための口。
  async function handleUploadPdfs(fileList) {
    const files = [...(fileList || [])].filter((f) => /\.pdf$/i.test(f.name));
    if (files.length === 0) {
      setError("PDFファイルを選んでください");
      return;
    }
    const company = companyName.trim() || deriveCompanyName(documents);
    if (!company) {
      setError("先に会社名を入力してください（保存先フォルダ名になります）");
      return;
    }
    if (!companyName.trim()) setCompanyName(company);

    setUploading(true);
    setError("");
    try {
      const form = new FormData();
      form.append("companyName", company);
      files.forEach((f) => form.append("files", f));
      const res = await fetch("/api/upload-local", { method: "POST", body: form });
      const data = await res.json();
      if (data.notes?.length) setNotes((prev) => [...prev, ...data.notes]);
      if (!res.ok) throw new Error(data.error || "PDFの取り込みに失敗しました");

      const fresh = data.documents || [];
      if (fresh.length === 0) throw new Error("取り込めるPDFがありませんでした");

      const merged = [...documents, ...fresh];
      setDocuments(merged);
      // 足したPDFは「見たくて足した」ものなので、標準セットに関係なく選択状態にする
      setSelected((prev) => {
        const next = { ...prev };
        fresh.forEach((d) => (next[d.id] = true));
        return next;
      });
      if (data.savedDir) setSavedDir(data.savedDir);
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
      setDragOver(false);
    }
  }

  // 手で触ったあとに標準セットへ戻すためのボタン用
  function selectStandardSet() {
    const std = new Set(pickStandardSet(documents).map((d) => d.id));
    setSelected(() => {
      const next = {};
      documents.forEach((d) => (next[d.id] = std.has(d.id)));
      return next;
    });
  }

  function setAllSelected(value) {
    setSelected((prev) => {
      const next = { ...prev };
      shelfDocs.forEach((d) => (next[d.id] = value));
      return next;
    });
  }

  async function handleRelabel() {
    const targets = shelfDocs.filter((d) => d.text);
    if (targets.length === 0) return;
    setRelabeling(true);
    setError("");
    try {
      const res = await fetch("/api/relabel-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documents: targets.map((d) => ({ id: d.id, text: d.text })) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "資料名の整理に失敗しました");
      const labels = data.labels || {};
      const fields = data.fields || {};
      setDocuments((docs) =>
        docs.map((d) => {
          if (!labels[d.id] && !fields[d.id]) return d;
          const f = fields[d.id] || {};
          return {
            ...d,
            label: labels[d.id] || d.label,
            docType: f.docType || d.docType,
            fiscalYear: f.fiscalYear || d.fiscalYear,
            quarter: f.quarter || d.quarter,
          };
        })
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setRelabeling(false);
    }
  }

  function removeDoc(id) {
    setDocuments(documents.filter((d) => d.id !== id));
    const next = { ...selected };
    delete next[id];
    setSelected(next);
  }

  function clearAll() {
    if (!confirm("資料棚をすべて空にします。よろしいですか？")) return;
    setDocuments([]);
    setSelected({});
    setMessages([]);
    setMetrics(null);
  }

  // 別の会社に移るとき用。画面に残っているものを一度に全部消して、まっさらに戻す。
  // 会社名・URL・資料棚・要約・分析・チャットが1つでも前の会社のまま残っていると、
  // 前の会社のフォルダに保存されたり、別会社の資料が混ざったりする。
  // 分析プロファイルと下限年は「設定」なので消さない。
  function startNewCompany() {
    if (
      !confirm(
        "新しい会社を始めます。会社名・証券コード・URL・資料棚・要約・分析・チャットをすべて消して、まっさらにします。\n\n" +
          "（分析の観点プロファイルと、取り込む決算期の下限はそのまま残ります）\n" +
          "パソコンに保存済みのPDFは消えません。"
      )
    )
      return;
    setCompanyName("");
    setTickerCode("");
    setUrls(["", "", "", "", "", ""]);
    setDocuments([]);
    setSelected({});
    setSummaries([]);
    setMetrics(null);
    setTechnical(null);
    setTechnicalError("");
    setCodeChoices([]);
    setAnalysis("");
    setMessages([]);
    setQuestion("");
    setNotes([]);
    setError("");
    setSavedDir("");
    setAutoStage("");
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(COMPANY_KEY);
      localStorage.removeItem(TICKER_KEY);
    } catch {}
  }

  // 資料棚は「いま入力されている会社」の資料だけを対象にする。
  // 資料棚は会社をまたいで蓄積されるので、絞らないと前の会社の資料が選択されたまま
  // 要約・分析に混ざってしまう（別会社の要約が出る事故の原因）。
  const currentCompany = companyName.trim();
  const shelfDocs = currentCompany
    ? documents.filter((d) => {
        const c = companyOfDoc(d);
        return !c || c === currentCompany;
      })
    : documents;
  const hiddenCount = documents.length - shelfDocs.length;

  const activeDocs = shelfDocs.filter((d) => selected[d.id]);
  const totalChars = activeDocs.reduce((sum, d) => sum + d.chars, 0);

  // 分析本文からランクを切り出し、先頭でバッジ表示する（本文側からは取り除く）
  const rankView = useMemo(() => extractRank(analysis), [analysis]);

  async function handleSummarize() {
    const targets = activeDocs.filter((d) => d.savedPath);
    if (targets.length === 0) {
      setError("要約する資料（保存済みPDF）を選択してください");
      return;
    }
    const company = companyName.trim() || deriveCompanyName(targets);
    if (!company) {
      setError("会社名を入力してください");
      return;
    }
    if (!companyName.trim()) setCompanyName(company);
    if (
      targets.length > 5 &&
      !window.confirm(
        `${targets.length}件を要約します。Opusがまとめて精読するため時間（数分〜十数分）とトークン消費が大きめです。続けますか？（必要な資料だけ選ぶことを推奨）`
      )
    ) {
      return;
    }
    setSummarizing(true);
    setError("");
    setNotes([]);
    try {
      const res = await fetchLongRunning("/api/summarize-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName: company,
          documents: targets.map((d) => ({ label: d.label, savedPath: d.savedPath })),
        }),
      });
      const data = await res.json();
      if (data.notes) setNotes(data.notes);
      if (!res.ok) throw new Error(data.error || "要約に失敗しました");
      setSummaries(data.summaries || []);
      await refreshMetrics(company, targets);
    } catch (e) {
      setError(e.message);
    } finally {
      setSummarizing(false);
    }
  }

  // 要約から業績数値を構造化して取り出す（表描画用）。
  // 失敗しても要約・分析は使えるので、エラーは画面全体を止めずに注記として出す。
  async function refreshMetrics(company, targets) {
    setMetricsBusy(true);
    try {
      const res = await fetchLongRunning("/api/metrics-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName: company,
          documents: targets.map((d) => ({ label: d.label, savedPath: d.savedPath })),
        }),
      });
      const data = await res.json();
      if (res.ok && data.metrics) setMetrics(data.metrics);
      else if (data.error) setNotes((n) => [...n, `業績表: ${data.error}`]);
    } catch (e) {
      setNotes((n) => [...n, `業績表の作成に失敗しました: ${e.message}`]);
    } finally {
      setMetricsBusy(false);
    }
  }

  // 株価の位置（週足・月足）を取りに行く。分析とは独立して失敗してよい。
  async function fetchTechnical(companyArg, tickerArg) {
    const company = (companyArg || companyName || "").trim();
    const ticker = (tickerArg ?? tickerCode ?? "").trim();
    if (!company && !ticker) return;
    setTechnicalBusy(true);
    setTechnicalError("");
    setCodeChoices([]);
    try {
      const qs = new URLSearchParams({ company, ticker });
      const res = await fetch(`/api/technical-local?${qs}`);
      const data = await res.json();
      if (res.status === 409 && data.ambiguous) {
        // 同名候補が複数。勝手に選ばず画面で選ばせる
        setCodeChoices(data.ambiguous);
        setTechnical(null);
        return;
      }
      if (!res.ok) throw new Error(data.error || "株価データを取得できませんでした");
      setTechnical(data);
    } catch (e) {
      setTechnical(null);
      setTechnicalError(e.message);
    } finally {
      setTechnicalBusy(false);
    }
  }

  async function handleAnalyze() {
    const company =
      companyName.trim() || deriveCompanyName(activeDocs) || deriveCompanyName(documents);
    if (!company) {
      setError("会社名を入力してください");
      return;
    }
    const targets = activeDocs.filter((d) => d.savedPath);
    if (targets.length === 0) {
      setError("分析する資料を選択してください（チェックした資料の要約だけを分析します）");
      return;
    }
    setAnalyzing(true);
    setError("");
    try {
      // 作成済みの事実サマリーがあればそれを分析対象にする。無ければ選択資料から読む。
      const summaryPayload =
        summaries.length > 0
          ? { summaries: summaries.map((s) => ({ label: s.label, text: s.text })) }
          : { documents: targets.map((d) => ({ label: d.label, savedPath: d.savedPath })) };
      const res = await fetchLongRunning("/api/analyze-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName: company,
          ...summaryPayload,
          profile: analysisProfile,
          external: useExternal,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "分析に失敗しました");
      setAnalysis(data.analysis || "");
      setSavedAt("");
      fetchTechnical(company, tickerCode);
    } catch (e) {
      setError(e.message);
    } finally {
      setAnalyzing(false);
    }
  }

  // チェックした資料を、要約→分析まで1クリックで通す（あなたの選択どおりに処理）
  async function handleSummarizeAndAnalyze() {
    const targets = activeDocs.filter((d) => d.savedPath);
    if (targets.length === 0) {
      setError("要約→分析する資料（保存済みPDF）にチェックを入れてください");
      return;
    }
    const company = companyName.trim() || deriveCompanyName(targets);
    if (!company) {
      setError("会社名を入力してください");
      return;
    }
    if (!companyName.trim()) setCompanyName(company);
    if (
      targets.length > 5 &&
      !window.confirm(
        `${targets.length}件を要約→分析します。Opusがまとめて精読するため時間とトークン消費が大きめです。続けますか？（必要な資料だけ選ぶことを推奨）`
      )
    ) {
      return;
    }
    setError("");
    setNotes([]);
    const docPayload = targets.map((d) => ({ label: d.label, savedPath: d.savedPath }));
    let consolidated = [];

    // 1) 要約（選択資料をまとめて事実サマリー1枚に。同じ組み合わせは再利用・再課金なし）
    setSummarizing(true);
    try {
      const sRes = await fetchLongRunning("/api/summarize-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyName: company, documents: docPayload }),
      });
      const sData = await sRes.json();
      if (sData.notes) setNotes(sData.notes);
      if (!sRes.ok) throw new Error(sData.error || "要約に失敗しました");
      consolidated = sData.summaries || [];
      setSummaries(consolidated);
      if (consolidated.length === 0) {
        throw new Error("事実サマリーを作成できませんでした（対象PDFを読み取れず）。");
      }
      await refreshMetrics(company, targets);
    } catch (e) {
      setError(e.message);
      setSummarizing(false);
      return;
    }
    setSummarizing(false);

    // 2) 分析（作った事実サマリーを土台に投資判断を出す）
    setAnalyzing(true);
    try {
      const aRes = await fetchLongRunning("/api/analyze-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName: company,
          summaries: consolidated.map((s) => ({ label: s.label, text: s.text })),
          profile: analysisProfile,
          external: useExternal,
        }),
      });
      const aData = await aRes.json();
      if (!aRes.ok) throw new Error(aData.error || "分析に失敗しました");
      setAnalysis(aData.analysis || "");
      setSavedAt("");
    } catch (e) {
      setError(e.message);
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleAutoRun() {
    if (!companyName.trim()) {
      setError("会社名を入力してください");
      return;
    }
    if (!urls.some((u) => (u || "").trim().startsWith("http"))) {
      setError("IRページのURLを1つ以上入力してください");
      return;
    }
    setError("");
    setNotes([]);
    setSummaries([]);
    setAnalysis("");
    setAutoRunning(true);
    try {
      // 1. 収集
      setAutoStage("① 収集中...（ブラウザ自動操作。数分かかることがあります）");
      const { res: cRes, data: cData } = await requestCollect();
      if (cData.notes) setNotes(cData.notes);
      if (!cRes.ok) throw new Error(cData.error || "収集に失敗しました");
      setSavedDir(cData.savedDir || "");

      const existingUrls = new Set(documents.map((d) => d.url));
      const fresh = cData.documents.filter((d) => !existingUrls.has(d.url));

      // 2. 資料名を中身から判定（リネーム＋種別・決算期の付与）。
      //    ファイル名が汎用（例: 野村の「PDF」）で収集時の分類が効かない場合でも、
      //    中身を読んで種別・時期を確定し、最新の主要資料を選別できるようにする。
      setAutoStage("② 資料名を判定中...（中身を読んで整理）");
      let enriched = cData.documents;
      const relTargets = cData.documents.filter((d) => d.text);
      if (relTargets.length) {
        try {
          const rRes = await fetch("/api/relabel-local", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              documents: relTargets.map((d) => ({ id: d.id, text: d.text })),
            }),
          });
          const rData = await rRes.json();
          if (rRes.ok) {
            const labels = rData.labels || {};
            const fields = rData.fields || {};
            enriched = cData.documents.map((d) => {
              const f = fields[d.id] || {};
              return {
                ...d,
                label: labels[d.id] || d.label,
                docType: f.docType || d.docType,
                fiscalYear: f.fiscalYear || d.fiscalYear,
                quarter: f.quarter || d.quarter,
              };
            });
          }
        } catch {
          // リネームに失敗しても収集済みの分類でそのまま続行
        }
      }

      const freshEnriched = enriched.filter((d) => !existingUrls.has(d.url));
      setDocuments([...documents, ...freshEnriched]);
      setSelected((prev) => {
        const next = { ...prev };
        freshEnriched.forEach((d) => (next[d.id] = true));
        return next;
      });

      // 3. 主要資料を選別して要約
      const core = pickCoreDocs(enriched);
      if (core.length === 0) {
        throw new Error(
          "要約対象（最新の決算短信・決算説明資料・有価証券報告書）が見つかりませんでした。収集は完了しています。資料棚から手動で選んで「選択資料の要約を作成」してください。"
        );
      }
      const ok = window.confirm(
        `全自動で ${core.length} 件（${core
          .map((d) => d.docType)
          .join("・")}）を要約→分析します。Opusがまとめて精読するため数分かかり、トークン消費も大きめです。続けますか？`
      );
      if (!ok) {
        setAutoStage("");
        return;
      }

      setAutoStage(`③ 要約中...（${core.length}件をOpusで精読）`);
      const sRes = await fetchLongRunning("/api/summarize-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName,
          documents: core.map((d) => ({ label: d.label, savedPath: d.savedPath })),
        }),
      });
      const sData = await sRes.json();
      if (sData.notes) setNotes((prev) => [...prev, ...sData.notes]);
      if (!sRes.ok) throw new Error(sData.error || "要約に失敗しました");
      setSummaries(sData.summaries || []);
      if ((sData.summaries || []).length === 0) {
        throw new Error("要約を生成できませんでした（対象PDFを読み取れず）。");
      }
      await refreshMetrics(companyName, core);

      // 3. 分析
      setAutoStage("④ 分析中...");
      const aRes = await fetchLongRunning("/api/analyze-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName,
          summaries: sData.summaries.map((s) => ({ label: s.label, text: s.text })),
          profile: analysisProfile,
        }),
      });
      const aData = await aRes.json();
      if (!aRes.ok) throw new Error(aData.error || "分析に失敗しました");
      setAnalysis(aData.analysis || "");
      setSavedAt("");
      setAutoStage("✓ 完了");
    } catch (e) {
      setError(e.message);
      setAutoStage("");
    } finally {
      setAutoRunning(false);
    }
  }

  // 添付ファイルをbase64にして持っておく（送信時にAPIへ渡す）
  const ATTACH_MAX_BYTES = 20 * 1024 * 1024;
  async function handleAttach(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    setAttachError("");
    const added = [];
    for (const file of files) {
      if (file.size > ATTACH_MAX_BYTES) {
        setAttachError(`${file.name} は大きすぎます（20MBまで）`);
        continue;
      }
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
        reader.onerror = () => reject(new Error("ファイルを読み込めませんでした"));
        reader.readAsDataURL(file);
      });
      const name = file.name || "file";
      // ブラウザが種類を判定できないファイルは拡張子から補う
      const ext = name.split(".").pop().toLowerCase();
      const guessed =
        file.type ||
        (ext === "pdf"
          ? "application/pdf"
          : ["png", "jpg", "jpeg", "gif", "webp"].includes(ext)
          ? `image/${ext === "jpg" ? "jpeg" : ext}`
          : "text/plain");
      added.push({ name, mediaType: guessed, size: file.size, data });
    }
    if (added.length) setAttachments((prev) => [...prev, ...added]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // パソコンに保存済みの事実サマリー・分析を読み込んで画面に戻す。
  // 分析結果はブラウザのメモリ上にしか無かったため、再読み込みで消えて
  // 「評価が出ていない」ように見えることがあった。ファイルが正。
  async function loadSaved(companyArg, { silent = false } = {}) {
    const company = (companyArg || companyName).trim();
    if (!company) {
      if (!silent) setError("会社名を入力してください");
      return;
    }
    if (!silent) setRestoring(true);
    try {
      // 業績表は要約・分析とは独立して保存されるので、先に読む。
      // 後ろに置くと「業績表はあるが分析はまだ」のときに早期リターンで復元されない。
      let hasMetrics = false;
      try {
        const mres = await fetch(`/api/metrics-local?company=${encodeURIComponent(company)}`);
        const mdata = await mres.json();
        if (mdata.metrics) {
          setMetrics(mdata.metrics);
          hasMetrics = true;
        }
      } catch {
        // 業績表が戻せなくても要約・分析の復元は続ける
      }

      const res = await fetch(`/api/saved-local?company=${encodeURIComponent(company)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "保存済みの分析を読み込めませんでした");
      if (!data.analysis && !data.summary) {
        if (!silent && !hasMetrics) setError("この会社の保存済みの分析はまだありません");
        return;
      }
      if (data.summary?.text) setSummaries([{ label: "事実サマリー", text: data.summary.text }]);
      if (data.analysis?.text) {
        setAnalysis(data.analysis.text);
        setSavedAt(data.analysis.savedAt || "");
      }
    } catch (e) {
      if (!silent) setError(e.message);
    } finally {
      if (!silent) setRestoring(false);
    }
  }

  async function handleAsk(text) {
    const q = (text || question).trim();
    if (!q) return;
    if (activeDocs.length === 0 && attachments.length === 0 && summaries.length === 0 && !analysis) {
      setError("資料を1件以上選ぶか、ファイルを添付してください");
      return;
    }

    const sent = attachments;
    const nextMessages = [
      ...messages,
      { role: "user", content: q, ...(sent.length ? { attachments: sent } : {}) },
    ];
    setMessages(nextMessages);
    setQuestion("");
    setAttachments([]);
    setAsking(true);
    setError("");

    try {
      const res = await fetchLongRunning("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documents: activeDocs,
          messages: nextMessages,
          // 画面に出ているサマリー・分析も同じ材料として渡す
          summaries: summaries.map((s2) => ({ label: s2.label, text: s2.text })),
          analysis,
          // 分析と同じ「外部情報を使う」トグルに従う
          external: useExternal,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "回答の取得に失敗しました");
      setMessages([...nextMessages, { role: "assistant", content: data.answer }]);
    } catch (e) {
      setError(e.message);
      setMessages(messages);
    } finally {
      setAsking(false);
    }
  }

  return (
    <main className="container">
      <header className="header">
        <h1>IR分析ツール</h1>
        <p className="lead">
          企業が開示している資料だけを根拠に分析します。資料に書かれていないことは答えません。
        </p>
      </header>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">1. 資料を取り込む</h2>
          <button onClick={startNewCompany} className="btn-reset">
            新しい会社を始める（全部クリア）
          </button>
        </div>
        <p className="hint">
          IR一覧ページのURL（決算短信・決算説明資料など）を入力してください。証券会社レポートなど個別のPDFは、そのPDFの直リンクURLをそのまま入れてもOKです（_参考資料フォルダに保存されます）。
        </p>

        <input
          type="text"
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
          placeholder="会社名（保存先フォルダ名になります）"
          className="url-input"
        />
        <input
          type="text"
          value={tickerCode}
          onChange={(e) => setTickerCode(e.target.value)}
          placeholder="証券コード（任意）"
          className="url-input"
        />

        {urls.map((url, i) => (
          <input
            key={i}
            type="text"
            value={url}
            onChange={(e) => updateUrl(i, e.target.value)}
            placeholder={
              i === 0
                ? "URL 1（IR資料室・決算資料一覧などのページ）"
                : `URL ${i + 1}（一覧ページ／PDFの直リンクも可・漏れた資料の手動追加に）`
            }
            className="url-input"
          />
        ))}
        <label className="minfy">
          <span>取り込む決算期の下限</span>
          <input
            type="number"
            value={minFiscalYear}
            onChange={(e) => setMinFiscalYear(e.target.value)}
            placeholder="2023"
            min="1900"
            max="2100"
            className="minfy-input"
          />
          <span>年3月期以降のみ（空欄で制限なし）</span>
        </label>
        <p className="hint">
          1つ目にIR資料室の一覧ページを入れれば、決算短信・決算説明資料・Q＆Aなどをまとめて取り込みます。取りこぼした資料があれば、そのPDFのURLを直接2つ目以降に貼ってください（種別も自動判定します／下限年に関係なく必ず取り込みます）。
        </p>

        {/* まず「取り込む」を主役に。集めてから資料棚で選び、要約・分析へ。 */}
        <button
          onClick={handleCollectLocal}
          disabled={collectingLocal || autoRunning}
          className="btn btn-primary"
        >
          {collectingLocal ? "取り込み中..." : "① 取り込む（PDFを保存）"}
        </button>
        <p className="hint">
          まずこれ。IRページからPDFを集めて ~/IR資料/ に保存します。取り込んだあと、下の「資料棚」で<b>必要な資料だけ選んで</b>要約・分析します（いらない資料を処理せず、コストも無駄になりません）。数分かかることがあります。
        </p>

        {/* おまかせ用（脇役）は折りたたみに畳んで、URL→取り込み→資料棚 の流れを乱さない */}
        <details className="omakase" open={autoRunning}>
          <summary>その他：全部おまかせで一気に処理する（自分で選ばない）</summary>
          <button
            onClick={handleAutoRun}
            disabled={autoRunning || collectingLocal}
            className="btn btn-ghost"
            style={{ marginTop: 8 }}
          >
            {autoRunning ? "全自動 実行中..." : "全自動（収集 → 要約 → 分析）でおまかせ"}
          </button>
          <p className="hint">
            自分で選ばず一気に済ませたいとき用。ただし要約・分析は「最新の決算短信・決算説明資料・有価証券報告書」を<b>自動で選んだぶんだけ</b>です。資料を自分で選びたいなら上の「① 取り込む」を使ってください。
          </p>
        </details>

        {autoStage && <p className="hint">進捗: {autoStage}</p>}

        {savedDir && <p className="hint">保存先: {savedDir}</p>}

        {notes.length > 0 && (
          <ul className="notes">
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
      </section>

      {error && <div className="error">{error}</div>}

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">2. 資料棚（{documents.length}件）</h2>
          {documents.length > 0 && (
            <span>
              <button onClick={handleRelabel} disabled={relabeling} className="link-btn">
                {relabeling ? "整理中..." : "資料名を整える"}
              </button>
              <button
                onClick={selectStandardSet}
                className="link-btn link-btn-primary"
                title="最新の決算短信・直近の通期短信・決算説明資料・質疑応答・説明会書き起こし・有価証券報告書・中期経営計画だけを選びます"
              >
                ★ 標準セットを選ぶ
              </button>
              <button onClick={() => setAllSelected(true)} className="link-btn">
                全選択
              </button>
              <button onClick={() => setAllSelected(false)} className="link-btn">
                全解除
              </button>
              <button onClick={clearAll} className="link-btn">
                すべて削除
              </button>
            </span>
          )}
        </div>

        <div
          className={`dropzone${dragOver ? " dropzone-over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); handleUploadPdfs(e.dataTransfer.files); }}
        >
          {uploading ? (
            <span>取り込み中...</span>
          ) : (
            <>
              <span className="dropzone-main">
                📎 手元のPDFをここにドラッグ&ドロップすると、資料棚に足せます
              </span>
              <span className="dropzone-sub">
                証券会社レポート・説明会の書き起こし・IRサイトに無い資料など。
                ファイル名から種別と決算期を自動で判定します。
              </span>
              <label className="dropzone-btn">
                ファイルを選ぶ
                <input
                  type="file"
                  accept="application/pdf"
                  multiple
                  style={{ display: "none" }}
                  onChange={(e) => { handleUploadPdfs(e.target.files); e.target.value = ""; }}
                />
              </label>
            </>
          )}
        </div>

        {shelfDocs.length === 0 ? (
          <p className="hint">
            まだ資料がありません。
            {hiddenCount > 0 &&
              `（他社の資料が${hiddenCount}件ありますが、「${currentCompany}」以外のため非表示です）`}
          </p>
        ) : (
          <>
            <ul className="doc-list">
              {shelfDocs.map((doc) => (
                <li key={doc.id} className="doc-item">
                  <label className="doc-label">
                    <input
                      type="checkbox"
                      checked={!!selected[doc.id]}
                      onChange={() => toggle(doc.id)}
                    />
                    <span className="doc-name">{doc.label}</span>
                  </label>
                  <span className="doc-meta">
                    {doc.pages}頁 / {doc.chars.toLocaleString()}字
                    {doc.savedPath ? ` / 保存済み` : ""}
                  </span>
                  <a href={doc.url} target="_blank" rel="noreferrer" className="doc-link">
                    原文
                  </a>
                  <button onClick={() => removeDoc(doc.id)} className="link-btn">
                    削除
                  </button>
                </li>
              ))}
            </ul>
            <p className="hint">
              選択中: {activeDocs.length}件 / 約{totalChars.toLocaleString()}字
              {hiddenCount > 0 &&
                ` ／ 他社の資料${hiddenCount}件は「${currentCompany}」以外のため非表示（要約・分析には含まれません）`}
            </p>
          </>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">3. 要約・分析（投資判断用）</h2>
        <p className="hint">
          選んだ複数期の資料をOpusがまとめて読み、<b>1枚の「事実サマリー」</b>（数値の推移・変化点だけ・最新の見通し／原文引用付き）を作り、それを土台に<b>投資判断（ポテンシャル・リスク）</b>を出します。四半期ごとの繰り返しはしません。トークン消費は大きめなので、各期の代表資料（決算短信など）を選ぶのがおすすめです。有報など100頁超は必要セクションを自動抜粋します。
        </p>

        <div className="howto">
          <strong>使い方</strong>
          <ol>
            <li>
              上の緑「<b>全自動</b>」を押した場合は、ここは不要です（収集→要約→分析まで済んでいます）。
            </li>
            <li>
              自分で選ぶとき：資料棚で必要な資料に<b>チェック</b> → 下の
              「<b>② 選択した資料をまとめて要約 → 分析</b>」を1回押すだけ（要約してそのまま分析まで）。
            </li>
            <li>
              要約だけ・分析だけ個別にやりたいときは、その下の「1ステップずつ実行」を開いてください。
            </li>
          </ol>
        </div>

        <div style={{ marginBottom: 10 }}>
          <label
            style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#2d3748", marginBottom: 4 }}
          >
            分析プロファイル（あなたの観点・手法。分析にだけ反映。要約は中立のまま）
          </label>
          <textarea
            value={analysisProfile}
            onChange={(e) => setAnalysisProfile(e.target.value)}
            rows={7}
            className="ask-input"
            style={{ width: "100%" }}
            placeholder="例）割安成長株を長期目線で。受注残高と営業CFを最重視。ですます調で結論から。"
          />
          <p className="hint">
            一度書けば保存され、以後の「分析」に自動で反映されます（原文引用・事実と所見の分離などの厳格ルールは常に維持）。業種は自動判定するので入れ替え不要です。
            <button
              onClick={() => setAnalysisProfile(DEFAULT_PROFILE)}
              className="link-btn"
              style={{ marginLeft: 8 }}
            >
              デフォルトに戻す
            </button>
          </p>
        </div>

        {/* 主役：チェックした資料を、要約→分析まで1クリック */}
        <button
          onClick={handleSummarizeAndAnalyze}
          disabled={summarizing || analyzing}
          className="btn btn-primary"
        >
          {summarizing
            ? "要約中..."
            : analyzing
            ? "分析中..."
            : "② 選択した資料をまとめて要約 → 分析"}
        </button>

        <label className="hint" style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", margin: "2px 0 10px" }}>
          <input
            type="checkbox"
            checked={useExternal}
            onChange={(e) => setUseExternal(e.target.checked)}
          />
          業界・市況リサーチも入れる（ブルームバーグ／ロイター／日経・証券会社のリサーチ・適時開示・東洋経済/四季報 に限定してWeb検索し、出典付きで分析に反映。SNSや個人ブログは検索対象に入りません。要約は一次情報のまま。少し遅く・検索コスト）
        </label>

        <div className="presets" style={{ marginBottom: 10 }}>
          <button
            type="button"
            onClick={() => loadSaved()}
            disabled={restoring || summarizing || analyzing}
            className="preset-btn"
            title="パソコンに保存済みの、この会社の最新の要約・分析を画面に戻します"
          >
            {restoring ? "読み込み中..." : "📂 保存済みの分析を開く"}
          </button>
        </div>

        {/* 補助：1ステップずつやりたいとき用 */}
        <details className="stepwise">
          <summary>1ステップずつ実行したいとき（要約だけ／分析だけ）</summary>
          <div className="presets" style={{ marginTop: 8 }}>
            <button onClick={handleSummarize} disabled={summarizing || analyzing} className="btn">
              {summarizing ? "作成中..." : "事実サマリーだけ作成"}
            </button>
            <button onClick={handleAnalyze} disabled={analyzing || summarizing} className="btn">
              {analyzing ? "分析中..." : "投資判断だけ（サマリーから）"}
            </button>
          </div>
        </details>

        {error && <div className="error">{error}</div>}
        {(summarizing || analyzing) && (
          <p className="hint">
            {summarizing ? "要約中..." : "分析中..."}（Opusで精読するため時間がかかります）
          </p>
        )}

        {/* 業績表（売上・営業利益・経常利益の推移と会社予想）。
            いちばん見たい数字なので、事実サマリーの本文より先に置く。 */}
        {metricsBusy && <p className="hint">業績表を作成中...</p>}
        {metrics && (
          <div className="chat">
            <div className="msg-ai">
              <PerformanceTable data={metrics} />
            </div>
          </div>
        )}

        {/* 事実サマリー（数値の推移・変化点・最新の見通し）を1枚で表示 */}
        {summaries.length > 0 && (
          <div className="chat">
            <div className="msg-ai">
              <strong>📄 事実サマリー（数値の推移・変化点・最新の見通し）</strong>
              <RichText text={summaries[0].text} />
            </div>
          </div>
        )}

        {/* 要約ができたが、まだ分析していないときの案内 */}
        {summaries.length > 0 && !analysis && !analyzing && (
          <p className="hint">
            事実サマリーができました。続けて<strong>投資判断</strong>を出すには、上の
            「② 選択した資料をまとめて要約 → 分析」（または「1ステップずつ」の分析だけ）を押してください。
          </p>
        )}

        {/* エントリー位置（週足・月足）。分析のあとに自動で取りに行くが、単体でも押せる */}
        <div className="tech-actions">
          <button
            type="button"
            onClick={() => fetchTechnical()}
            disabled={technicalBusy}
            className="preset-btn"
            title="週足・月足の移動平均乖離とボリンジャーバンドから、いま買う位置かを確認します"
          >
            {technicalBusy ? "株価を確認中..." : "📉 いま買う位置か確認する"}
          </button>
        </div>
        {technicalError && <div className="error">{technicalError}</div>}
        {codeChoices.length > 0 && (
          <div className="tech-choices">
            <span>同名の候補が複数あります。銘柄を選んでください：</span>
            {codeChoices.map((c) => (
              <button
                key={c.code}
                type="button"
                className="preset-btn"
                onClick={() => { setTickerCode(c.code); fetchTechnical(companyName, c.code); }}
              >
                {c.name}（{c.code}）
              </button>
            ))}
          </div>
        )}
        {technical && (
          <div className="chat">
            <div className="msg-ai">
              <TechnicalPanel data={technical} />
            </div>
          </div>
        )}

        {/* 投資判断（ポテンシャル・リスク） */}
        {analysis && (
          <div className="chat">
            <div className="msg-ai">
              <strong>📊 投資判断（ポテンシャル・リスク）</strong>
              {savedAt && (
                <span className="saved-tag">
                  保存済みファイルから復元：{formatSavedAt(savedAt)}
                </span>
              )}
              <RankBadge rank={rankView.rank} />
              <RichText text={rankView.rest} />
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">4. 質問する</h2>

        {messages.length === 0 && (
          <div className="presets">
            {PRESET_QUESTIONS.map((p) => (
              <button key={p} onClick={() => handleAsk(p)} className="preset-btn">
                {p}
              </button>
            ))}
          </div>
        )}

        <div className="chat">
          {messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "msg-user" : "msg-ai"}>
              {m.role === "user" ? (
                <>
                  <pre>{m.content}</pre>
                  {Array.isArray(m.attachments) && m.attachments.length > 0 && (
                    <div className="attach-list">
                      {m.attachments.map((a, ai) => (
                        <span key={ai} className="attach-chip">
                          📎 {a.name}
                        </span>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <RichText text={m.content} />
              )}
            </div>
          ))}
          {asking && <div className="msg-ai thinking">資料を読んでいます...</div>}
          <div ref={bottomRef} />
        </div>

        {attachments.length > 0 && (
          <div className="attach-list attach-pending">
            {attachments.map((a, i) => (
              <span key={i} className="attach-chip">
                📎 {a.name}
                <span className="attach-size">
                  {a.size > 1024 * 1024
                    ? `${(a.size / 1024 / 1024).toFixed(1)}MB`
                    : `${Math.max(1, Math.round(a.size / 1024))}KB`}
                </span>
                <button
                  type="button"
                  className="attach-remove"
                  onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                  aria-label={`${a.name} を外す`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {attachError && <p className="hint attach-error">{attachError}</p>}

        <div className="ask-row">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="例）受注残高の推移と、その背景を教えて（ファイルを添付して質問できます）"
            className="ask-input"
            rows={2}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.md,.csv,.json,.htm,.html"
            onChange={(e) => handleAttach(e.target.files)}
            style={{ display: "none" }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={asking}
            className="btn btn-attach"
            title="PDF・画像・テキストを添付して質問できます"
          >
            📎 ファイル
          </button>
          <button onClick={() => handleAsk()} disabled={asking} className="btn">
            送信
          </button>
        </div>
        <p className="hint">
          添付したPDF・画像はそのまま読み取って回答に使います（1ファイル20MBまで）。
        </p>

        {error && <div className="error">{error}</div>}
      </section>
    </main>
  );
}
