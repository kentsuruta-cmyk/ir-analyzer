// 得意先（主要な販売先）の業績を、J-Quants の決算短信データから機械的にまとめる。
//
// 「得意先が好調かどうか」は、その会社自身の資料にはまず書かれていない。
// かといってモデルに語らせると記憶頼みになるので、ここは得意先の直近の決算
// （前年同期比・会社予想の修正・株価）を数字で並べるだけにする。
import { resolveCode, fetchStatements, fetchDailyBars } from "./jquants.js";

const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const pctChange = (now, before) =>
  now != null && before != null && before > 0 ? (now / before - 1) * 100 : null;

// "2026-03-31" → "2025-03-31"（うるう日は月末のずれを気にせず年月で比べる）
const ym = (d) => (d || "").slice(0, 7);
const prevYearYm = (d) => (d ? `${Number(d.slice(0, 4)) - 1}${d.slice(4, 7)}` : "");

const isRevision = (r) => /Revision/i.test(r.DocType || "");
const isStatement = (r) => !isRevision(r) && num(r.Sales) != null;

// statements: fetchStatements の戻り（古い順） / daily: fetchDailyBars の戻り
export function summarizeStatus(statements, daily) {
  const reports = (statements || []).filter(isStatement);
  const latest = reports[reports.length - 1];
  if (!latest) return { error: "決算データがありません" };

  // 前年の同じ四半期（累計どうし）
  const prev = reports.find(
    (r) => r.CurPerType === latest.CurPerType && ym(r.CurFYEn) === prevYearYm(latest.CurFYEn)
  );
  const yoy = prev
    ? {
        sales: pctChange(num(latest.Sales), num(prev.Sales)),
        op: pctChange(num(latest.OP), num(prev.OP)),
        np: pctChange(num(latest.NP), num(prev.NP)),
        // 前年が赤字・ゼロだと増減率が出せないので、向きだけ言葉で持つ
        opNote:
          num(prev.OP) != null && num(latest.OP) != null && num(prev.OP) <= 0
            ? num(latest.OP) > 0 ? "黒字転換" : "赤字継続"
            : num(latest.OP) != null && num(latest.OP) < 0 ? "赤字転落" : "",
      }
    : null;

  // いまの期の通期予想（営業利益。無ければ純利益）を、期初から最新まで時系列で集める。
  // 本決算の短信では「来期」の欄に入っているので、対象期で突き合わせる。
  const latestIsFY = latest.CurPerType === "FY";
  const fy = latestIsFY ? latest.NxtFYEn : latest.CurFYEn;
  const forecasts = [];
  for (const r of statements) {
    let op = null, np = null;
    if (!isRevision(r) && r.CurPerType === "FY" && ym(r.NxtFYEn) === ym(fy)) {
      op = num(r.NxFOP); np = num(r.NxFNp);
    } else if (ym(r.CurFYEn) === ym(fy)) {
      op = num(r.FOP); np = num(r.FNP);
    }
    if (op != null || np != null) forecasts.push({ date: r.DiscDate, op, np });
  }
  let forecast = null;
  if (forecasts.length) {
    const first = forecasts[0];
    const last = forecasts[forecasts.length - 1];
    const key = last.op != null && first.op != null ? "op" : "np";
    // 前の期の通期実績
    const prevFY = reports.find((r) => r.CurPerType === "FY" && ym(r.CurFYEn) === prevYearYm(fy));
    forecast = {
      fyEnd: fy,
      basis: key === "op" ? "営業利益" : "純利益",
      value: last[key],
      asOf: last.date,
      revisionPct: pctChange(last[key], first[key]), // 期初予想からの修正幅
      growthPct: prevFY ? pctChange(last[key], num(key === "op" ? prevFY.OP : prevFY.NP)) : null, // 前期実績比
    };
  }

  let price = null;
  if (daily?.length) {
    const last = daily[daily.length - 1];
    const back = (days) => {
      const t = new Date(new Date(last.date + "T00:00:00Z").getTime() - days * 864e5).toISOString().slice(0, 10);
      const hit = [...daily].reverse().find((d) => d.date <= t);
      return hit ? (last.close / hit.close - 1) * 100 : null;
    };
    price = { close: last.close, asOf: last.date, m3: back(91), y1: back(365) };
  }

  // 向きを1文字にまとめる。直近の利益（無ければ売上）の増減と、予想修正の向きを足すだけ。
  const dir = (v, eps = 0) => (v == null ? 0 : v > eps ? 1 : v < -eps ? -1 : 0);
  // 営業利益を開示しない会社（IFRSで事業利益を使う会社など）は純利益で見る
  const profitDir = yoy
    ? yoy.op != null ? dir(yoy.op)
      : yoy.opNote === "黒字転換" ? 1 : yoy.opNote ? -1
      : yoy.np != null ? dir(yoy.np) : dir(yoy.sales)
    : 0;
  const score = profitDir + dir(forecast?.revisionPct, 1);
  const mark = !yoy && !forecast ? "不明" : score > 0 ? "○" : score < 0 ? "×" : "△";

  return {
    period: `${ym(latest.CurFYEn).replace("-", "年")}月期 ${latest.CurPerType === "FY" ? "通期" : latest.CurPerType + "累計"}`,
    disclosed: latest.DiscDate,
    yoy,
    forecast,
    price,
    mark,
  };
}

// 名前（または証券コード）の一覧から、各社の状態を取る。
// selfCode: 分析対象の会社自身（得意先として自社が挙がったら除く）
export async function customersStatus(entries, { selfCode } = {}) {
  const out = [];
  const seen = new Set();
  for (const e of entries) {
    const base = { name: e.name, note: e.note || "", source: e.source || "", manual: !!e.manual };
    let resolved = null;
    try {
      resolved = await resolveCode({ companyName: e.name, tickerCode: e.code || "" });
    } catch (err) {
      out.push({ ...base, error: err.message });
      continue;
    }
    if (!resolved) {
      out.push({ ...base, unresolved: "国内の上場銘柄に見つかりません（海外・非上場の会社は決算を取れません）" });
      continue;
    }
    if (resolved.ambiguous) {
      out.push({ ...base, unresolved: "同名の候補が複数あります。証券コードで追加してください", candidates: resolved.ambiguous });
      continue;
    }
    if (resolved.code === selfCode || seen.has(resolved.code)) continue;
    seen.add(resolved.code);
    try {
      const [statements, daily] = await Promise.all([
        fetchStatements({ code: resolved.code }),
        fetchDailyBars({ code: resolved.code, days: 400 }),
      ]);
      out.push({ ...base, code: resolved.code, listedName: resolved.name, ...summarizeStatus(statements, daily) });
    } catch (err) {
      out.push({ ...base, code: resolved.code, listedName: resolved.name, error: err.message });
    }
  }
  return out;
}
