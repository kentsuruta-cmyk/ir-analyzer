// J-Quants (JPX) V2 の薄いクライアント。
// market-flow で使っているものと同じキー・同じエンドポイント。
// V2 は x-api-key ヘッダー方式でトークンの期限切れが無いため、更新処理は不要。
const BASE = "https://api.jquants.com/v2";

function headers() {
  const key = process.env.JQUANTS_API_KEY;
  if (!key) throw new Error("JQUANTS_API_KEY が設定されていません（.env.local）");
  return { "x-api-key": key };
}

async function get(pathAndQuery) {
  const res = await fetch(BASE + pathAndQuery, { headers: headers() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`J-Quants ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.data || [];
}

let masterCache = { rows: null, at: 0 };
const MASTER_TTL_MS = 6 * 60 * 60 * 1000;

async function getMaster() {
  if (masterCache.rows && Date.now() - masterCache.at < MASTER_TTL_MS) return masterCache.rows;
  const rows = await get("/equities/master");
  masterCache = { rows, at: Date.now() };
  return rows;
}

// 全角・記号・法人格の揺れを吸収してから突き合わせる
function normalizeName(s) {
  return (s || "")
    .normalize("NFKC")
    .replace(/(株式会社|有限会社|\(株\)|㈱)/g, "")
    .replace(/[\s・,，.．\-―ー]/g, "")
    .toLowerCase();
}

// 会社名または証券コードから J-Quants の5桁コードを引く。
// 4桁ティッカーで渡されたら末尾に0を足す（V2は5桁表記）。
export async function resolveCode({ companyName, tickerCode }) {
  const rows = await getMaster();

  const t = (tickerCode || "").trim();
  if (t) {
    const five = /^\d{4}$/.test(t) ? `${t}0` : t;
    const hit = rows.find((r) => r.Code === five);
    if (hit) return { code: hit.Code, name: hit.CoName, matchedBy: "コード" };
  }

  const target = normalizeName(companyName);
  if (!target) return null;

  let hit = rows.find((r) => normalizeName(r.CoName) === target);
  if (hit) return { code: hit.Code, name: hit.CoName, matchedBy: "会社名（完全一致）" };

  // 「マニー」と「マニー株式会社」のような揺れを拾う
  const partial = rows.filter((r) => {
    const n = normalizeName(r.CoName);
    return n && (n.startsWith(target) || target.startsWith(n));
  });
  if (partial.length === 1) {
    return { code: partial[0].Code, name: partial[0].CoName, matchedBy: "会社名（部分一致）" };
  }
  if (partial.length > 1) {
    // 候補が割れたときは黙って1つ選ばず、呼び出し側に返して画面で選ばせる
    return {
      ambiguous: partial.slice(0, 8).map((r) => ({ code: r.Code, name: r.CoName })),
    };
  }
  return null;
}

// 日足（調整後）を取得する。days は暦日数。
export async function fetchDailyBars({ code, days = 1100 }) {
  const to = new Date();
  const from = new Date(Date.now() - days * 864e5);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const rows = await get(
    `/equities/bars/daily?code=${encodeURIComponent(code)}&from=${fmt(from)}&to=${fmt(to)}`
  );
  // 分割・併合の影響を受けない調整後の値を使う。無い場合だけ生値にフォールバック。
  return rows
    .map((r) => ({
      date: r.Date,
      open: r.AdjO ?? r.O,
      high: r.AdjH ?? r.H,
      low: r.AdjL ?? r.L,
      close: r.AdjC ?? r.C,
      volume: r.AdjVo ?? r.Vo,
      marketCap: r.MktCap ?? null,
    }))
    .filter((r) => r.close != null)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}
