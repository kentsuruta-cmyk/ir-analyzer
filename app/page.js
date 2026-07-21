"use client";

import { useState, useEffect, useRef } from "react";

const STORAGE_KEY = "ir-analyzer-documents";

const PRESET_QUESTIONS = [
  "業績のサマリーを教えて",
  "利益が変動した要因は？",
  "今期の会社見通しと進捗は？",
  "リスク・懸念点を挙げて",
];

export default function Home() {
  const [urls, setUrls] = useState(["", "", ""]);
  const [documents, setDocuments] = useState([]);
  const [selected, setSelected] = useState({});
  const [collecting, setCollecting] = useState(false);
  const [notes, setNotes] = useState([]);
  const [error, setError] = useState("");

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
    } catch {}
    setLoaded(true);
  }, []);

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

  async function handleCollect() {
    setCollecting(true);
    setError("");
    setNotes([]);

    try {
      const res = await fetch("/api/collect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
      });
      const data = await res.json();
      if (data.notes) setNotes(data.notes);
      if (!res.ok) throw new Error(data.error || "取り込みに失敗しました");

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
      setCollecting(false);
    }
  }

  function toggle(id) {
    setSelected({ ...selected, [id]: !selected[id] });
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
          決算短信・決算説明資料など、PDFが一覧表示されているページのURLを入力してください。
        </p>

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

        <button onClick={handleCollect} disabled={collecting} className="btn">
          {collecting ? "取り込み中..." : "取り込む"}
        </button>

        {collecting && (
          <p className="hint">PDFの数によっては1〜2分かかります。</p>
        )}

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
            <button onClick={clearAll} className="link-btn">
              すべて削除
            </button>
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
        <h2 className="card-title">3. 質問する</h2>

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
      </section>
    </main>
  );
}
