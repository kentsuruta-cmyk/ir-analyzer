// 過去のPERと比べて、いまの株価がどの位置にあるかを計算する。
//
// 「会社が良いか」と「いまの値段が高いか」は別の問いなので、ここは後者だけを扱う。
// モデルには何も推測させず、J-Quants の株価と決算短信の会社予想EPSだけで出す。
//
// PERは日本株で一般的な「予想PER」（株価 ÷ その時点で出ていた会社予想EPS）。
// 各営業日について「その日までに開示されていた最新の会社予想」を当てるので、
// 後から分かった数字で過去を塗り替えることはしない。

const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// 決算短信・業績修正の1行から「その開示で示された会社予想」を取り出す。
// 本決算の短信は終わった期ではなく来期の予想（Nx〜）を見る。単体のみの会社は単体の予想を使う。
function forecastOf(row) {
  // 業績修正は期の区分が FY でも「いまの期」の予想の修正なので、来期の欄は見ない
  const isRevision = /Revision/i.test(row.DocType || "");
  const isFY = row.CurPerType === "FY" && !isRevision;
  const eps = isFY
    ? num(row.NxFEPS) ?? num(row.NxFNCEPS)
    : num(row.FEPS) ?? num(row.FNCEPS);
  const np = isFY
    ? num(row.NxFNp) ?? num(row.NxFNCNP)
    : num(row.FNP) ?? num(row.FNCNP);
  if (eps == null && np == null) return null;
  const issued = num(row.ShOutFY);
  return {
    date: row.DiscDate,
    eps,
    np,
    // 自己株式を除いた期末の株数（業績修正の開示には載らない）
    shares: issued > 0 ? issued - (num(row.TrShFY) || 0) : null,
    fyEnd: (isFY ? row.NxtFYEn : row.CurFYEn) || "",
    isRevision,
  };
}

// 開示された予想を「いまの株数」ベースのEPSに直す。
//
// 開示された予想EPSをそのまま使うと、株式分割の前後で桁がずれる。会社は分割の効力発生より前に
// 「分割後ベース」の予想EPSを出すことがあり、その開示がどちらの単位なのかはEPSだけでは分からない
// （イビデンの2025年10月・2026年8月の短信がこの形で、PERが2倍・4倍に化けた）。
// 予想純利益は分割の影響を受けないので、予想純利益 ÷ いまの単位に直した株数 で出す。
// 株数が取れない開示だけ、予想EPS × 分割倍率 で代用する。
function toCurrentShareBasis(forecasts, daily) {
  const out = [];
  let sharesNow = null; // 直近の開示に載っていた株数を、いまの単位に直したもの
  for (const f of forecasts) {
    const k = splitFactorAt(daily, f.date);
    if (f.shares > 0) sharesNow = f.shares / k;
    let epsAdj = null;
    if (f.np != null && sharesNow > 0) epsAdj = f.np / sharesNow;
    else if (f.eps != null) epsAdj = f.eps * k;
    if (epsAdj != null) out.push({ ...f, epsAdj });
  }
  return out;
}

// 開示日の 調整後終値÷生の終値。その日から現在までの株式分割の累積倍率になる
// （1株→2株の分割がその後に1回あれば0.5）。
function splitFactorAt(daily, date) {
  let f = 1;
  for (const d of daily) {
    if (d.date > date) break;
    if (d.rawClose > 0 && d.close > 0) f = d.close / d.rawClose;
  }
  return f;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// 予想の対象期が終わってからこの日数を過ぎても次の予想が出ていなければ、予想なしとして扱う。
// （予想を出さない会社で、終わった期の予想を延々と使い続けないため）
const STALE_AFTER_FY_END_DAYS = 120;

// PERの位置から付ける評価のしきい値（過去の分布の中で下から何%にいるか）。
// 根拠を画面に出せるよう定数として外に出す。
export const POSITION_GRADES = [
  { grade: "A", below: 25, label: "過去と比べて低い位置" },
  { grade: "B", below: 50, label: "過去の中央より低い位置" },
  { grade: "C", below: 80, label: "過去の中央より高い位置" },
  { grade: "D", below: 101, label: "過去と比べてかなり高い位置" },
];

function daysBetween(a, b) {
  return (new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 864e5;
}

// daily: fetchDailyBars の戻り（rawClose 付き） / statements: fetchStatements の戻り
export function computeValuation(daily, statements) {
  if (!daily?.length) return { error: "株価データがありません" };

  const forecasts = toCurrentShareBasis(
    (statements || []).map(forecastOf).filter(Boolean).sort((a, b) => (a.date < b.date ? -1 : 1)),
    daily
  );
  if (!forecasts.length) {
    return { error: "通期の会社予想（純利益・EPS）が開示されていないため、予想PERを計算できません" };
  }

  // 各営業日に、その前日までに開示されていた最新の予想を当てる
  // （短信は引け後に出ることが多いので、開示日当日の終値には織り込まれていないとみなす）
  const series = [];
  let fi = -1;
  let lossDays = 0;
  let noForecastDays = 0;
  for (const d of daily) {
    while (fi + 1 < forecasts.length && forecasts[fi + 1].date < d.date) fi++;
    const f = fi >= 0 ? forecasts[fi] : null;
    if (!f) continue; // 最初の開示より前
    if (f.fyEnd && daysBetween(f.fyEnd, d.date) > STALE_AFTER_FY_END_DAYS) { noForecastDays++; continue; }
    if (f.epsAdj <= 0) { lossDays++; continue; } // 赤字予想の日はPERが定義できない
    series.push({ date: d.date, close: d.close, eps: f.epsAdj, per: d.close / f.epsAdj });
  }
  if (series.length < 120) {
    return { error: `予想PERを計算できる日が少なすぎます（${series.length}営業日）。赤字予想や予想非開示の期間が長い銘柄です。` };
  }

  const last = series[series.length - 1];
  const lastBar = daily[daily.length - 1];
  if (last.date !== lastBar.date) {
    return { error: "いまの期の通期の会社予想が赤字または非開示のため、現在の予想PERを計算できません（半期の予想しか出さない会社など）" };
  }

  const sorted = series.map((s) => s.per).sort((a, b) => a - b);
  const band = {
    min: sorted[0],
    p10: percentile(sorted, 0.1),
    p25: percentile(sorted, 0.25),
    median: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9),
    max: sorted[sorted.length - 1],
  };
  // 現在のPERより低かった日の割合（0=過去最低、100=過去最高）
  const positionPct = (sorted.filter((v) => v < last.per).length / sorted.length) * 100;
  const g = POSITION_GRADES.find((x) => positionPct < x.below);

  // いまの予想EPSに過去のPERを掛けたときの株価
  const scenario = [
    ["過去の下位10%", band.p10],
    ["過去の下位25%", band.p25],
    ["過去の中央値", band.median],
    ["過去の上位25%", band.p75],
    ["過去の上位10%", band.p90],
    ["過去の最高", band.max],
  ].map(([label, per]) => ({
    label,
    per,
    price: per * last.eps,
    changePct: ((per * last.eps) / last.close - 1) * 100,
  }));

  // 年ごとのPERの幅
  const byYear = new Map();
  for (const s of series) {
    const y = s.date.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(s);
  }
  const yearly = [...byYear.entries()].map(([year, rows]) => {
    const v = rows.map((r) => r.per).sort((a, b) => a - b);
    return {
      year,
      low: v[0],
      median: percentile(v, 0.5),
      high: v[v.length - 1],
      epsEnd: rows[rows.length - 1].eps,
      days: rows.length,
    };
  });

  // この1年の株価の動きを「利益予想の変化」と「PERの変化」に分ける
  // （株価 = EPS × PER なので、2つの倍率の掛け算になる）
  let oneYear = null;
  const target = new Date(new Date(last.date + "T00:00:00Z").getTime() - 365 * 864e5).toISOString().slice(0, 10);
  const past = [...series].reverse().find((s) => s.date <= target);
  if (past) {
    oneYear = {
      fromDate: past.date,
      pricePct: (last.close / past.close - 1) * 100,
      epsPct: (last.eps / past.eps - 1) * 100,
      perPct: (last.per / past.per - 1) * 100,
      perFrom: past.per,
      epsFrom: past.eps,
    };
  }

  // グラフ用に週1点へ間引く（各週の最後の営業日）
  const weekly = [];
  for (let i = 0; i < series.length; i++) {
    const cur = new Date(series[i].date + "T00:00:00Z");
    const next = series[i + 1] ? new Date(series[i + 1].date + "T00:00:00Z") : null;
    if (!next || next.getUTCDay() < cur.getUTCDay() || next - cur > 6 * 864e5) {
      weekly.push({ date: series[i].date, per: series[i].per, eps: series[i].eps });
    }
  }

  const current = forecasts[forecasts.length - 1];
  return {
    asOf: last.date,
    price: last.close,
    per: last.per,
    eps: last.eps,
    epsSource: { date: current.date, fyEnd: current.fyEnd, isRevision: current.isRevision },
    from: series[0].date,
    days: series.length,
    lossDays,
    noForecastDays,
    band,
    positionPct,
    grade: g.grade,
    gradeLabel: g.label,
    scenario,
    yearly,
    oneYear,
    weekly,
    // 会社予想EPSの修正履歴（新しい順に直近8件）
    revisions: forecasts.slice(-8).reverse().map((f) => ({ date: f.date, eps: f.epsAdj, fyEnd: f.fyEnd })),
  };
}
