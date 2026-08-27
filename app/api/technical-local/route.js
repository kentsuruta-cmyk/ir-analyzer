import { resolveCode, fetchDailyBars } from "../../../lib/jquants.js";
import { computeTechnical } from "../../../lib/technical.js";

export const runtime = "nodejs";
export const maxDuration = 120;

// 「良い会社を、伸び切ったところで買わない」ための位置確認。
// 週足・月足の移動平均乖離とボリンジャーバンドのσ位置だけを見る。
// 売買の推奨ではなく、エントリー時期の足切り材料として使う。
export async function GET(request) {
  if (process.env.VERCEL) {
    return Response.json({ error: "このAPIはVercel上では実行できません。" }, { status: 501 });
  }
  try {
    if (!process.env.JQUANTS_API_KEY) {
      return Response.json(
        { error: "JQUANTS_API_KEY が未設定です（.env.local に追加してサーバーを再起動してください）" },
        { status: 500 }
      );
    }

    const sp = new URL(request.url).searchParams;
    const companyName = (sp.get("company") || "").trim();
    const tickerCode = (sp.get("ticker") || "").trim();
    if (!companyName && !tickerCode) {
      return Response.json({ error: "会社名か証券コードが必要です" }, { status: 400 });
    }

    const resolved = await resolveCode({ companyName, tickerCode });
    if (!resolved) {
      return Response.json(
        { error: `「${companyName || tickerCode}」に対応する上場銘柄が見つかりませんでした。証券コードを入力してください。` },
        { status: 404 }
      );
    }
    if (resolved.ambiguous) {
      // 候補が割れたときは黙って選ばない。画面で選んでもらう。
      return Response.json({ ambiguous: resolved.ambiguous }, { status: 409 });
    }

    const daily = await fetchDailyBars({ code: resolved.code, days: 1100 });
    const technical = computeTechnical(daily);
    if (technical.error) return Response.json({ error: technical.error }, { status: 422 });

    return Response.json({
      code: resolved.code,
      name: resolved.name,
      matchedBy: resolved.matchedBy,
      technical,
    });
  } catch (e) {
    return Response.json({ error: `エラー: ${e.message}` }, { status: 500 });
  }
}
