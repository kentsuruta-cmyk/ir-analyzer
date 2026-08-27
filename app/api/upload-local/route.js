import crypto from "crypto";
import { saveDocument, getCompanyDir } from "../../../lib/filesave.js";
import { classifyFromLabel } from "../../../lib/classify.js";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_CHARS_PER_PDF = 200000;
const MAX_BYTES = 60 * 1024 * 1024;

// 手元のPDFを資料棚に足す。
// IRサイトを辿らずに入手した資料（証券会社レポート、説明会の書き起こし、
// 会社から直接もらった資料など）を、あとから何度でも足せるようにするための口。
// 収集(collect-local)と同じ形の document を返すので、画面側は同じ扱いができる。

async function extractText(buffer) {
  try {
    const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
    const parsed = await pdfParse(buffer);
    return { text: parsed.text || "", pages: parsed.numpages || 0 };
  } catch {
    // 画像PDFなど。保存はするので本文なしで通す
    return { text: "", pages: 0 };
  }
}

export async function POST(request) {
  if (process.env.VERCEL) {
    return Response.json(
      { error: "このAPIはVercel上では実行できません。ローカルで実行してください。" },
      { status: 501 }
    );
  }

  try {
    const form = await request.formData();
    const company = (form.get("companyName") || "").toString().trim();
    if (!company) return Response.json({ error: "会社名がありません" }, { status: 400 });

    const files = form.getAll("files").filter((f) => typeof f === "object" && f.size >= 0);
    if (files.length === 0) return Response.json({ error: "PDFが指定されていません" }, { status: 400 });

    const documents = [];
    const notes = [];

    for (const file of files) {
      const name = file.name || "無題.pdf";
      if (!/\.pdf$/i.test(name)) {
        notes.push(`${name} … PDFではないため取り込みませんでした`);
        continue;
      }
      if (file.size > MAX_BYTES) {
        notes.push(`${name} … サイズが大きすぎます（60MBまで）`);
        continue;
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      const { text, pages } = await extractText(buffer);

      // ファイル名から種別・決算期を推定する。読めなければ本文の冒頭も見る。
      const baseLabel = name.replace(/\.pdf$/i, "");
      let cls = classifyFromLabel(baseLabel);
      if (cls.confidence !== "high" && text) {
        const fromBody = classifyFromLabel(text.slice(0, 400));
        cls = {
          docType: cls.docType || fromBody.docType,
          fiscalYear: cls.fiscalYear || fromBody.fiscalYear,
          quarter: cls.quarter || fromBody.quarter,
          confidence: cls.docType || fromBody.docType ? "high" : "low",
        };
      }

      const result = saveDocument({
        buffer,
        companyName: company,
        fiscalYear: cls.fiscalYear,
        quarter: cls.quarter,
        docType: cls.docType,
        sourceUrl: `file://${name}`,
      });

      if (!text) {
        notes.push(`${name} … 保存しました（画像PDFのため本文抽出不可・要約時はNotebookLM推奨）`);
      }

      documents.push({
        id: crypto.randomUUID(),
        label: baseLabel,
        url: `file://${name}`,
        text: text.slice(0, MAX_CHARS_PER_PDF),
        chars: Math.min(text.length, MAX_CHARS_PER_PDF),
        pages,
        addedAt: new Date().toISOString(),
        docType: cls.docType || "不明",
        fiscalYear: cls.fiscalYear || "不明",
        quarter: cls.quarter || "不明",
        savedPath: result.path,
        uploaded: true,
      });
    }

    return Response.json({ documents, notes, savedDir: getCompanyDir(company) });
  } catch (e) {
    return Response.json({ error: `エラー: ${e.message}` }, { status: 500 });
  }
}
