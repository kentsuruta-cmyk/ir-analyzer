"use client";

import { useState } from "react";

export default function Home() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");

  async function handleAnalyze() {
    if (!url) {
      setError("URLを入力してください");
      return;
    }
    setLoading(true);
    setError("");
    setResult("");

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "エラーが発生しました");
      }
      setResult(data.analysis);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="container">
      <h1>IR分析ツール</h1>
      <p className="lead">
        企業のIRページのURLを入力すると、掲載されているPDF資料を自動で集めてAIが分析します。
      </p>

      <div className="input-row">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.co.jp/ir/library/"
          className="url-input"
        />
        <button onClick={handleAnalyze} disabled={loading} className="btn">
          {loading ? "分析中..." : "分析する"}
        </button>
      </div>

      {loading && (
        <p className="note">
          PDFの収集と分析に1〜3分かかることがあります。そのままお待ちください。
        </p>
      )}

      {error && <div className="error">{error}</div>}

      {result && (
        <div className="result">
          <h2>分析結果</h2>
          <pre>{result}</pre>
        </div>
      )}
    </main>
  );
}
