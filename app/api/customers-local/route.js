import fs from "fs";
import path from "path";
import { getCompanyDir } from "../../../lib/filesave.js";
import { resolveCode } from "../../../lib/jquants.js";
import { customersStatus } from "../../../lib/customers.js";

export const runtime = "nodejs";
export const maxDuration = 120;

// 手で足した得意先の置き場。資料に社名が載らない得意先（売上の10%未満など）は
// ここに覚えておき、次に開いたときも並ぶようにする。
function manualPath(company) {
  return path.join(getCompanyDir(company), "_指標", "得意先.json");
}
function readManual(company) {
  try {
    const d = JSON.parse(fs.readFileSync(manualPath(company), "utf8"));
    return Array.isArray(d.manual) ? d.manual : [];
  } catch {
    return [];
  }
}
function writeManual(company, manual) {
  const p = manualPath(company);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ manual }, null, 2));
}

// 得意先の一覧（資料から拾ったもの＋手で足したもの）について、各社の直近の決算をまとめて返す。
// body: { companyName, tickerCode, extracted: [{name,note,source}], add?: "社名か証券コード", remove?: "社名" }
export async function POST(request) {
  if (process.env.VERCEL) {
    return Response.json({ error: "このAPIはVercel上では実行できません。" }, { status: 501 });
  }
  try {
    if (!process.env.JQUANTS_API_KEY) {
      return Response.json({ error: "JQUANTS_API_KEY が未設定です（.env.local）" }, { status: 500 });
    }
    const { companyName, tickerCode, extracted, add, remove } = await request.json();
    const company = (companyName || "").trim();
    if (!company) return Response.json({ error: "会社名がありません" }, { status: 400 });

    let manual = readManual(company);

    const addText = (add || "").trim();
    if (addText) {
      const isCode = /^\d{4,5}$|^\d{3}[A-Z]\d?$/i.test(addText);
      const r = await resolveCode(isCode ? { tickerCode: addText } : { companyName: addText });
      if (!r) {
        return Response.json(
          { error: `「${addText}」は国内の上場銘柄に見つかりませんでした。証券コードで試してください。` },
          { status: 404 }
        );
      }
      if (r.ambiguous) {
        return Response.json(
          { error: `「${addText}」は候補が複数あります（${r.ambiguous.map((c) => `${c.name} ${c.code.slice(0, 4)}`).join("、")}）。証券コードで追加してください。` },
          { status: 409 }
        );
      }
      if (!manual.some((m) => m.code === r.code)) {
        manual = [...manual, { name: r.name, code: r.code }];
        writeManual(company, manual);
      }
    }
    const removeText = (remove || "").trim();
    if (removeText) {
      manual = manual.filter((m) => m.name !== removeText);
      writeManual(company, manual);
    }

    let selfCode = null;
    try {
      const self = await resolveCode({ companyName: company, tickerCode: tickerCode || "" });
      if (self && !self.ambiguous) selfCode = self.code;
    } catch {
      // 自社を特定できなくても続ける
    }

    const entries = [
      ...(Array.isArray(extracted) ? extracted : []).map((c) => ({ name: c.name, note: c.note, source: c.source })),
      ...manual.map((m) => ({ name: m.name, code: m.code, note: "手で追加", manual: true })),
    ];
    const customers = await customersStatus(entries, { selfCode });
    return Response.json({ customers });
  } catch (e) {
    return Response.json({ error: `エラー: ${e.message}` }, { status: 500 });
  }
}
