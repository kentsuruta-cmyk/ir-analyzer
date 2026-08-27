// 週足・月足のテクニカル指標。
// 目的は「良い会社を、高値づかみしない位置で買う」ための足切り。
// 上がり続ける銘柄をただ避けるのではなく、移動平均からの乖離と
// ボリンジャーバンドのσ位置で「今は伸び切っているか」を見る。

// 日足を週足に畳む（月曜起点）。最後の週は未完成のまま含める（＝現在値）。
export function toWeekly(daily) {
  const buckets = new Map();
  for (const d of daily) {
    const dt = new Date(d.date + "T00:00:00Z");
    const day = dt.getUTCDay();              // 0=日
    const diff = day === 0 ? 6 : day - 1;    // 月曜までの戻り日数
    const monday = new Date(dt.getTime() - diff * 864e5).toISOString().slice(0, 10);
    if (!buckets.has(monday)) buckets.set(monday, []);
    buckets.get(monday).push(d);
  }
  return foldBuckets(buckets);
}

// 日足を月足に畳む。最後の月は未完成のまま含める。
export function toMonthly(daily) {
  const buckets = new Map();
  for (const d of daily) {
    const key = d.date.slice(0, 7);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(d);
  }
  return foldBuckets(buckets);
}

function foldBuckets(buckets) {
  return [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, rows]) => ({
      period: key,
      open: rows[0].open,
      high: Math.max(...rows.map((r) => r.high)),
      low: Math.min(...rows.map((r) => r.low)),
      close: rows[rows.length - 1].close,
      lastDate: rows[rows.length - 1].date,
      bars: rows.length,
    }));
}

export function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// 標準偏差（母集団）。ボリンジャーバンドの慣例に合わせる。
export function stdev(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const v = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  return Math.sqrt(v);
}

function deviationPct(price, ma) {
  if (ma == null || ma === 0) return null;
  return ((price - ma) / ma) * 100;
}

// 現値がボリンジャーバンドの何σにいるか。+3 に近いほど買われ過ぎ。
function sigmaPosition(price, ma, sd) {
  if (ma == null || sd == null || sd === 0) return null;
  return (price - ma) / sd;
}

function analyzeSeries(series, { maShort, maLong, bbPeriod = 20 }) {
  const closes = series.map((s) => s.close);
  const price = closes[closes.length - 1];
  const short = sma(closes, maShort);
  const long = sma(closes, maLong);
  const bbMa = sma(closes, bbPeriod);
  const bbSd = stdev(closes, bbPeriod);
  const sigma = sigmaPosition(price, bbMa, bbSd);

  return {
    bars: series.length,
    lastPeriod: series[series.length - 1]?.period || null,
    lastDate: series[series.length - 1]?.lastDate || null,
    price,
    maShort: short,
    maLong: long,
    maShortPeriod: maShort,
    maLongPeriod: maLong,
    deviationShortPct: deviationPct(price, short),
    deviationLongPct: deviationPct(price, long),
    bb: bbMa == null ? null : {
      period: bbPeriod,
      middle: bbMa,
      sigma1: [bbMa - bbSd, bbMa + bbSd],
      sigma2: [bbMa - 2 * bbSd, bbMa + 2 * bbSd],
      sigma3: [bbMa - 3 * bbSd, bbMa + 3 * bbSd],
      position: sigma,          // 現値のσ位置
    },
  };
}

// 判定のしきい値。根拠を示せるよう定数として外に出す。
export const THRESHOLDS = {
  sigmaHot: 2.5,        // これ以上なら3σ接近＝買われ過ぎ
  sigmaWarm: 2.0,
  weeklyDevHot: 25,     // 週足13週線からの上方乖離(%)
  weeklyDevWarm: 15,
  monthlyDevHot: 35,    // 月足12ヶ月線からの上方乖離(%)
  monthlyDevWarm: 20,
};

// 週足・月足の結果から、エントリーの可否を1つにまとめる。
function judge(weekly, monthly) {
  const reasons = [];
  let level = 0; // 0=許容 1=やや過熱 2=過熱

  const bump = (n, text) => { level = Math.max(level, n); reasons.push(text); };

  const ws = weekly.bb?.position;
  const ms = monthly.bb?.position;
  if (ws != null) {
    if (ws >= THRESHOLDS.sigmaHot) bump(2, `週足のボリンジャーバンドで+${ws.toFixed(1)}σ（3σに接近）`);
    else if (ws >= THRESHOLDS.sigmaWarm) bump(1, `週足のボリンジャーバンドで+${ws.toFixed(1)}σ（2σ超え）`);
    else if (ws <= -THRESHOLDS.sigmaWarm) reasons.push(`週足で${ws.toFixed(1)}σ（下振れ側・売られ過ぎ寄り）`);
  }
  if (ms != null) {
    if (ms >= THRESHOLDS.sigmaHot) bump(2, `月足のボリンジャーバンドで+${ms.toFixed(1)}σ（3σに接近）`);
    else if (ms >= THRESHOLDS.sigmaWarm) bump(1, `月足のボリンジャーバンドで+${ms.toFixed(1)}σ（2σ超え）`);
  }

  const wd = weekly.deviationShortPct;
  const md = monthly.deviationShortPct;
  if (wd != null) {
    if (wd >= THRESHOLDS.weeklyDevHot) bump(2, `週足${weekly.maShortPeriod}週線から+${wd.toFixed(1)}%上方乖離`);
    else if (wd >= THRESHOLDS.weeklyDevWarm) bump(1, `週足${weekly.maShortPeriod}週線から+${wd.toFixed(1)}%上方乖離`);
  }
  if (md != null) {
    if (md >= THRESHOLDS.monthlyDevHot) bump(2, `月足${monthly.maShortPeriod}ヶ月線から+${md.toFixed(1)}%上方乖離`);
    else if (md >= THRESHOLDS.monthlyDevWarm) bump(1, `月足${monthly.maShortPeriod}ヶ月線から+${md.toFixed(1)}%上方乖離`);
  }

  const verdict =
    level === 2 ? "見送り・押し目待ち" : level === 1 ? "やや過熱（分割エントリー向き）" : "位置は許容範囲";

  // 押し目の目安を、避けたい理由と同じ物差し（移動平均）で出す
  const targets = [];
  if (weekly.maShort != null) targets.push({ label: `週足${weekly.maShortPeriod}週線`, value: weekly.maShort });
  if (weekly.maLong != null) targets.push({ label: `週足${weekly.maLongPeriod}週線`, value: weekly.maLong });
  if (weekly.bb?.middle != null) targets.push({ label: `週足ボリンジャー中心線(${weekly.bb.period})`, value: weekly.bb.middle });

  return {
    level,
    verdict,
    reasons: reasons.length ? reasons : ["移動平均・ボリンジャーバンドともに過熱の兆候なし"],
    pullbackTargets: targets,
  };
}

// daily: fetchDailyBars の戻り
export function computeTechnical(daily) {
  if (!daily || daily.length < 30) {
    return { error: "株価データが足りません（30営業日未満）" };
  }
  const weeklySeries = toWeekly(daily);
  const monthlySeries = toMonthly(daily);

  // 週足13週=約3ヶ月・26週=約半年、月足12/24ヶ月。日本株で一般的な組み合わせ。
  const weekly = analyzeSeries(weeklySeries, { maShort: 13, maLong: 26, bbPeriod: 20 });
  const monthly = analyzeSeries(monthlySeries, { maShort: 12, maLong: 24, bbPeriod: 20 });

  return {
    asOf: daily[daily.length - 1].date,
    price: daily[daily.length - 1].close,
    weekly,
    monthly,
    judgement: judge(weekly, monthly),
    // 直近1年の高値・安値（今の位置感を掴むため）
    range52w: (() => {
      const y = daily.slice(-250);
      return { high: Math.max(...y.map((d) => d.high)), low: Math.min(...y.map((d) => d.low)) };
    })(),
  };
}
