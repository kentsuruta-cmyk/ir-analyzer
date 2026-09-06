// 同業他社との数字の比較を作る。
//
// 「競合は誰か」をモデルの記憶に頼ると、もっともらしい社名と数字を作りかねない。
// ここは推測を挟まず、実データで並べる。
//
// データは高配当スクリーナー側で毎朝作っている universe.json を読む。
// 全上場3,000社超の業種・株価・時価総額・決算が入っており、
// 同じマシンの中にあるので取り直す必要がない。無ければ比較を諦めるだけで、
// 分析そのものは従来どおり動く。
import fs from "fs";
import os from "os";
import path from "path";

const UNIVERSE =
  process.env.PEERS_UNIVERSE ||
  path.join(os.homedir(), "dividend-screener", "data", "universe.json");

let cache = null;
let cacheMtime = 0;

function loadUniverse() {
  try {
    const st = fs.statSync(UNIVERSE);
    if (cache && st.mtimeMs === cacheMtime) return cache;
    cache = JSON.parse(fs.readFileSync(UNIVERSE, "utf8"));
    cacheMtime = st.mtimeMs;
    return cache;
  } catch {
    return null;
  }
}

const n = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));

// 1社ぶんの指標。売上・利益は最新の本決算、EPSは会社予想があればそちら。
function metricsOf(c) {
  const a = c.annuals || [];
  const last = a[a.length - 1] || null;
  const prev = a[a.length - 2] || null;
  if (!last) return null;

  const sales = n(last.sales);
  const op = n(last.op);
  const np = n(last.np);
  const eq = n(last.eq);
  const eps = n(c.fcst?.eps) ?? n(last.eps);
  const bps = n(last.bps);
  const div = n(c.fcst?.div) ?? n(last.div);
  const price = n(c.price);

  return {
    code: c.code,
    ticker: c.ticker,
    name: c.name,
    sector: c.sector,
    mktcapOku: n(c.mktcapOku),
    sales,
    opMargin: sales > 0 && op != null ? (op / sales) * 100 : null,
    roe: eq > 0 && np != null ? (np / eq) * 100 : null,
    eqAR: last.eqAR == null ? null : Number(last.eqAR) * 100,
    salesGrowth: prev && n(prev.sales) > 0 && sales > 0 ? (sales / prev.sales - 1) * 100 : null,
    opGrowth: prev && n(prev.op) > 0 && op > 0 ? (op / prev.op - 1) * 100 : null,
    per: price != null && eps > 0 ? price / eps : null,
    pbr: price != null && bps > 0 ? price / bps : null,
    dividendYield: price > 0 && div != null ? (div / price) * 100 : null,
  };
}

const median = (arr) => {
  const v = arr.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = Math.floor(v.length / 2);
  return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2;
};

// 大きいほど良い指標は降順、小さいほど良い指標（PER/PBR）は昇順で順位を付ける
function rankOf(list, key, value, lowerIsBetter = false) {
  if (value == null) return null;
  const v = list.map((x) => x[key]).filter((x) => x != null);
  if (!v.length) return null;
  const better = lowerIsBetter
    ? v.filter((x) => x < value).length
    : v.filter((x) => x > value).length;
  return { rank: better + 1, of: v.length };
}

// ticker（4桁）または code（5桁）で会社を探し、同業の比較を返す。
export function peersFor(ticker) {
  const u = loadUniverse();
  if (!u?.companies?.length) return null;
  const key = String(ticker || "").trim();
  if (!key) return null;

  const target = u.companies.find((c) => c.ticker === key || c.code === key);
  if (!target) return null;
  const tm = metricsOf(target);
  if (!tm) return null;

  const peers = u.companies
    .filter((c) => c.sector === target.sector && c.code !== target.code)
    .map(metricsOf)
    .filter(Boolean);
  if (peers.length < 5) return null;

  const all = [tm, ...peers];
  const keys = [
    ["opMargin", false], ["roe", false], ["eqAR", false],
    ["salesGrowth", false], ["opGrowth", false], ["sales", false],
    ["mktcapOku", false], ["per", true], ["pbr", true], ["dividendYield", false],
  ];
  const med = {}, ranks = {};
  for (const [k, low] of keys) {
    med[k] = median(all.map((x) => x[k]));
    ranks[k] = rankOf(all, k, tm[k], low);
  }

  // 規模が近い会社（売上が0.5〜2倍）を、売上の近い順に
  const near = tm.sales
    ? peers
        .filter((p) => p.sales > 0 && p.sales / tm.sales >= 0.5 && p.sales / tm.sales <= 2)
        .sort((a, b) => Math.abs(a.sales - tm.sales) - Math.abs(b.sales - tm.sales))
        .slice(0, 6)
    : [];

  // 同業で営業利益率の高い会社（この会社が追う相手／脅威になりうる相手）
  const best = peers
    .filter((p) => p.opMargin != null && p.sales > 0)
    .sort((a, b) => b.opMargin - a.opMargin)
    .slice(0, 5);

  return {
    priceDate: u.priceDate,
    sector: target.sector,
    count: all.length,
    target: tm,
    median: med,
    ranks,
    near,
    best,
  };
}

const oku = (v) => (v == null ? "—" : Math.round(v / 1e8).toLocaleString());
const f1 = (v, u = "") => (v == null ? "—" : v.toFixed(1) + u);
const f2 = (v, u = "") => (v == null ? "—" : v.toFixed(2) + u);

// 分析プロンプトに渡す文章。数字は全部ここにあるので、モデルは読み解くだけでよい。
export function formatPeers(p) {
  if (!p) return "";
  const row = (m) =>
    [
      `${m.name}(${m.ticker})`,
      oku(m.sales) + "億",
      f1(m.opMargin, "%"),
      f1(m.salesGrowth, "%"),
      f1(m.opGrowth, "%"),
      f1(m.roe, "%"),
      f1(m.eqAR, "%"),
      f2(m.per, "倍"),
      f2(m.pbr, "倍"),
      f2(m.dividendYield, "%"),
    ].join(" | ");

  const head = "会社 | 売上 | 営業利益率 | 増収率 | 営業増益率 | ROE | 自己資本比率 | PER | PBR | 配当利回り";
  const L = [];
  L.push(`【同業比較（東証33業種「${p.sector}」の上場${p.count}社。株価は${p.priceDate}時点）】`);
  L.push("これは上場企業のデータベースから機械的に並べたもので、推測は入っていません。");
  L.push("ただし非上場の競合・海外勢・事業の一部だけが競合する会社は、この表には入りません。");
  L.push("売上・利益・ROEは**最新の本決算**の数字です（PERとPBRと配当利回りだけ会社予想と現在の株価）。");
  L.push("直近の四半期の急回復や悪化は、この表の順位には反映されていません。");
  L.push("事実サマリー側に新しい四半期があるときは、そのずれを断ってから読んでください。");
  L.push("");
  L.push(head);
  L.push(`**${row(p.target)}**  ← 分析対象`);
  L.push(`業種の中央値 | ${oku(p.median.sales)}億 | ${f1(p.median.opMargin, "%")} | ${f1(p.median.salesGrowth, "%")} | ${f1(p.median.opGrowth, "%")} | ${f1(p.median.roe, "%")} | ${f1(p.median.eqAR, "%")} | ${f2(p.median.per, "倍")} | ${f2(p.median.pbr, "倍")} | ${f2(p.median.dividendYield, "%")}`);
  L.push("");

  const r = (k, label) => {
    const x = p.ranks[k];
    return x ? `${label} ${x.rank}位/${x.of}社` : null;
  };
  L.push("業種内での順位: " + [
    r("sales", "売上規模"), r("opMargin", "営業利益率"), r("roe", "ROE"),
    r("salesGrowth", "増収率"), r("opGrowth", "営業増益率"), r("eqAR", "自己資本比率"),
    r("per", "PERの低さ"), r("pbr", "PBRの低さ"), r("dividendYield", "配当利回り"),
  ].filter(Boolean).join(" ／ "));
  L.push("");

  if (p.near.length) {
    L.push(`■ 売上規模が近い同業（${oku(p.target.sales)}億円の0.5〜2倍）`);
    L.push(head);
    for (const m of p.near) L.push(row(m));
    L.push("");
  }
  if (p.best.length) {
    L.push("■ 同業で営業利益率が高い会社（追う相手・脅威になりうる相手）");
    L.push(head);
    for (const m of p.best) L.push(row(m));
    L.push("");
  }
  L.push("注: 業種は東証33業種の分類なので、実際の競合と一致しないことがあります。");
  L.push("　　事業内容が違う会社が同じ業種に入ることも、真の競合が別業種にいることもあります。");
  L.push("　　その点は資料やWeb検索で補い、表を鵜呑みにしないでください。");
  return L.join("\n");
}
