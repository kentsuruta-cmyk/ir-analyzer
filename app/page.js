"use client";

import { useState, useEffect, useRef } from "react";

const STORAGE_KEY = "ir-analyzer-documents";
const PROFILE_KEY = "ir-analyzer-profile";
const COMPANY_KEY = "ir-analyzer-company";
const TICKER_KEY = "ir-analyzer-ticker";

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

// 保存済みPDFのパス（~/Documents/IR資料/{会社名}/...）から会社名を取り出す。
function deriveCompanyName(docs) {
  for (const d of docs) {
    if (d.savedPath) {
      const after = d.savedPath.split("/IR資料/")[1];
      if (after) return after.split("/")[0];
    }
  }
  return "";
}

// 全自動で要約する主要資料を選ぶ。種別ごとに最新年度（同年なら通期優先）を1件ずつ。
function pickCoreDocs(docs) {
  const latestOf = (typeIncludes) => {
    const cands = docs.filter(
      (d) => d.savedPath && (d.docType || "").includes(typeIncludes)
    );
    if (!cands.length) return null;
    cands.sort((a, b) => {
      const fy = (b.fiscalYear || "").localeCompare(a.fiscalYear || "");
      if (fy !== 0) return fy;
      return (a.quarter === "通期" ? 0 : 1) - (b.quarter === "通期" ? 0 : 1);
    });
    return cands[0];
  };
  const core = [
    latestOf("決算短信"),
    latestOf("決算説明資料"),
    latestOf("有価証券報告書"),
  ].filter(Boolean);
  // 重複除去
  const seen = new Set();
  return core.filter((d) => (seen.has(d.url) ? false : (seen.add(d.url), true)));
}

export default function Home() {
  const [urls, setUrls] = useState(["", "", "", "", "", ""]);  const [documents, setDocuments] = useState([]);
  const [selected, setSelected] = useState({});
  const [notes, setNotes] = useState([]);
  const [error, setError] = useState("");

  const [companyName, setCompanyName] = useState("");
  const [tickerCode, setTickerCode] = useState("");
  const [collectingLocal, setCollectingLocal] = useState(false);
  const [savedDir, setSavedDir] = useState("");

  const [summarizing, setSummarizing] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [summaries, setSummaries] = useState([]);
  const [analysis, setAnalysis] = useState("");

  const [autoRunning, setAutoRunning] = useState(false);
  const [autoStage, setAutoStage] = useState("");
  const [analysisProfile, setAnalysisProfile] = useState(DEFAULT_PROFILE);

  const [messages, setMessages] = useState([]);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
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
    } catch {}
  }, [analysisProfile, companyName, tickerCode, loaded]);

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

  async function handleCollectLocal() {
    setCollectingLocal(true);
    setError("");
    setNotes([]);

    try {
      const res = await fetch("/api/collect-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyName, tickerCode, urls }),
      });
      const data = await res.json();
      if (data.notes) setNotes(data.notes);
      if (!res.ok) throw new Error(data.error || "収集に失敗しました");

      setSavedDir(data.savedDir || "");

      const existingUrls = new Set(documents.map((d) => d.url));
      const fresh = data.documents.filter((d) => !existingUrls.has(d.url));

      setDocuments([...documents, ...fresh]);
      setSelected((prev) => {
        const next = { ...prev };
        fresh.forEach((d) => (next[d.id] = true));
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

  function setAllSelected(value) {
    const next = {};
    documents.forEach((d) => (next[d.id] = value));
    setSelected(next);
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
  }

  const activeDocs = documents.filter((d) => selected[d.id]);
  const totalChars = activeDocs.reduce((sum, d) => sum + d.chars, 0);

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
        `${targets.length}件を要約します。Opusで1件ずつ読むため時間（数分〜十数分）とトークン消費が大きめです。続けますか？（必要な資料だけ選ぶことを推奨）`
      )
    ) {
      return;
    }
    setSummarizing(true);
    setError("");
    setNotes([]);
    try {
      const res = await fetch("/api/summarize-local", {
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
    } catch (e) {
      setError(e.message);
    } finally {
      setSummarizing(false);
    }
  }

  async function handleAnalyze() {
    const company =
      companyName.trim() || deriveCompanyName(activeDocs) || deriveCompanyName(documents);
    if (!company) {
      setError("会社名を入力してください");
      return;
    }
    setAnalyzing(true);
    setError("");
    try {
      const res = await fetch("/api/analyze-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // summaries を送らないことで、その会社の保存済み要約すべて（_要約/*.md）を対象に分析する
          companyName: company,
          profile: analysisProfile,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "分析に失敗しました");
      setAnalysis(data.analysis || "");
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
      const cRes = await fetch("/api/collect-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyName, tickerCode, urls }),
      });
      const cData = await cRes.json();
      if (cData.notes) setNotes(cData.notes);
      if (!cRes.ok) throw new Error(cData.error || "収集に失敗しました");
      setSavedDir(cData.savedDir || "");

      const existingUrls = new Set(documents.map((d) => d.url));
      const fresh = cData.documents.filter((d) => !existingUrls.has(d.url));
      setDocuments([...documents, ...fresh]);
      setSelected((prev) => {
        const next = { ...prev };
        fresh.forEach((d) => (next[d.id] = true));
        return next;
      });

      // 2. 主要資料を選別して要約
      const core = pickCoreDocs(cData.documents);
      if (core.length === 0) {
        throw new Error(
          "要約対象（最新の決算短信・決算説明資料・有価証券報告書）が見つかりませんでした。収集は完了しています。"
        );
      }
      const ok = window.confirm(
        `全自動で ${core.length} 件（${core
          .map((d) => d.docType)
          .join("・")}）を要約→分析します。Opusで1件ずつ読むため数分かかり、トークン消費も大きめです。続けますか？`
      );
      if (!ok) {
        setAutoStage("");
        return;
      }

      setAutoStage(`② 要約中...（${core.length}件をOpusで精読）`);
      const sRes = await fetch("/api/summarize-local", {
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

      // 3. 分析
      setAutoStage("③ 分析中...");
      const aRes = await fetch("/api/analyze-local", {
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
      setAutoStage("✓ 完了");
    } catch (e) {
      setError(e.message);
      setAutoStage("");
    } finally {
      setAutoRunning(false);
    }
  }

  async function handleAsk(text) {
    const q = (text || question).trim();
    if (!q) return;
    if (activeDocs.length === 0) {
      setError("資料を1件以上選択してください");
      return;
    }

    const nextMessages = [...messages, { role: "user", content: q }];
    setMessages(nextMessages);
    setQuestion("");
    setAsking(true);
    setError("");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documents: activeDocs, messages: nextMessages }),
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
        <h2 className="card-title">1. 資料を取り込む</h2>
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
            placeholder={`URL ${i + 1}`}
            className="url-input"
          />
        ))}

        <button
          onClick={handleAutoRun}
          disabled={autoRunning || collectingLocal}
          className="btn btn-primary"
        >
          {autoRunning ? "全自動 実行中..." : "全自動（収集 → 要約 → 分析）"}
        </button>
        <p className="hint">
          URLから、収集・保存・要約・分析までを一気に実行します。要約は「最新の決算短信・決算説明資料・有価証券報告書」を自動選別（Opusで精読）。全資料を要約したいときは下の個別ボタンを使ってください。
        </p>

        {autoStage && <p className="hint">進捗: {autoStage}</p>}

        <button
          onClick={handleCollectLocal}
          disabled={collectingLocal || autoRunning}
          className="btn"
        >
          {collectingLocal ? "収集中..." : "取り込むだけ（PDFを保存）"}
        </button>
        <p className="hint">
          ブラウザを自動操作して年度セレクタも辿り、PDFを ~/Documents/IR資料/ に保存します。数分かかることがあります。
        </p>

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

        {documents.length === 0 ? (
          <p className="hint">まだ資料がありません。</p>
        ) : (
          <>
            <ul className="doc-list">
              {documents.map((doc) => (
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
            </p>
          </>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">3. 要約・分析（一次情報を正確に）</h2>
        <p className="hint">
          選択中の保存済みPDFをOpusが直接読み、原文引用・出典ページ付きで要約します。数字が命の用途向け。トークン消費は大きめなので、必要な資料だけ選んでください。有価証券報告書など100頁超はMD&A・経理などの必要セクションを自動抜粋します。
        </p>

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

        <div className="presets">
          <button onClick={handleSummarize} disabled={summarizing} className="btn">
            {summarizing ? "要約を作成中..." : "選択資料の要約を作成"}
          </button>
          <button onClick={handleAnalyze} disabled={analyzing} className="btn">
            {analyzing ? "分析中..." : "要約から分析（保存済み要約すべて）"}
          </button>
        </div>

        {error && <div className="error">{error}</div>}
        {(summarizing || analyzing) && (
          <p className="hint">
            {summarizing ? "要約中..." : "分析中..."}（Opusで精読するため時間がかかります）
          </p>
        )}

        {summaries.length > 0 && (
          <div className="chat">
            {summaries.map((s, i) => (
              <div key={i} className="msg-ai">
                <strong>{s.label}</strong>
                <pre>{s.text}</pre>
              </div>
            ))}
          </div>
        )}

        {analysis && (
          <div className="chat">
            <div className="msg-ai">
              <strong>分析レポート</strong>
              <pre>{analysis}</pre>
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
              <pre>{m.content}</pre>
            </div>
          ))}
          {asking && <div className="msg-ai thinking">資料を読んでいます...</div>}
          <div ref={bottomRef} />
        </div>

        <div className="ask-row">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="例）受注残高の推移と、その背景を教えて"
            className="ask-input"
            rows={2}
          />
          <button onClick={() => handleAsk()} disabled={asking} className="btn">
            送信
          </button>
        </div>

        {error && <div className="error">{error}</div>}
      </section>
    </main>
  );
}
