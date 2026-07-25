import { PDFDocument } from "pdf-lib";

// ClaudeのPDF上限は約100ページ/32MB。安全マージンを取る。
export const MAX_PAGES = 100;
export const MAX_BYTES = 30 * 1024 * 1024;

export async function getPageCount(buffer) {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  return doc.getPageCount();
}

export function withinLimits(buffer, pageCount) {
  return buffer.length <= MAX_BYTES && pageCount <= MAX_PAGES;
}

// pdf-parseでページごとのテキストを取得する（pages[i] = i+1ページ目の本文）。
// 画像PDFの場合は各要素が空文字になる。
export async function getPerPageText(buffer) {
  const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
  const pages = [];
  await pdfParse(buffer, {
    pagerender: async (pageData) => {
      const content = await pageData.getTextContent();
      const text = content.items.map((i) => i.str).join(" ");
      pages.push(text);
      return text;
    },
  });
  return pages;
}

// 有価証券報告書の章見出し。本文中とともに目次ページにも出るため、
// 目次ページ（多数の見出しが1ページに集まる）は除外して実際の章開始ページを探す。
const SECTION_MARKERS = {
  s1: /第\s*1\s*[[【]\s*企業の概況/,
  s2: /第\s*2\s*[[【]\s*事業の状況/,
  s3: /第\s*3\s*[[【]\s*設備の状況/,
  s4: /第\s*4\s*[[【]\s*提出会社の状況/,
  s5: /第\s*5\s*[[【]\s*経理の状況/,
  s6: /第\s*6\s*[[【]/,
  audit: /独立監査人の(監査|四半期レビュー)報告書|監査報告書/,
  part2: /第二部\s*[[【]\s*提出会社の保証会社等の情報/,
};

// 「残す」ページ範囲（[start, endExclusive) のページindex配列）を求める。
// 残す: 第1（企業の概況）＋第2（事業の状況/MD&A） と 第5（経理の状況）。
// 落とす: 第3設備・第4株式事務等、第6以降、監査報告書、第二部、附属明細表。
export function findKeepRanges(pages) {
  const names = Object.keys(SECTION_MARKERS);
  const tocPages = new Set();
  const hits = {};

  pages.forEach((text, i) => {
    let count = 0;
    for (const name of names) {
      if (SECTION_MARKERS[name].test(text)) {
        (hits[name] ||= []).push(i);
        count++;
      }
    }
    if (count >= 4) tocPages.add(i); // 目次らしきページ
  });

  const firstReal = (name) => (hits[name] || []).find((i) => !tocPages.has(i));
  const s1 = firstReal("s1");
  const s3 = firstReal("s3");
  const s5 = firstReal("s5");
  const s6 = firstReal("s6");
  const audit = firstReal("audit");
  const part2 = firstReal("part2");

  if (s1 == null || s5 == null) return null; // 章を特定できず

  const ranges = [];
  // 第1＋第2: s1 〜 第3の手前（無ければ第5の手前）
  ranges.push([s1, s3 != null && s3 > s1 ? s3 : s5]);
  // 第5（経理）: s5 〜 第6/監査報告書/第二部 のうち最も早いもの（無ければ末尾）
  const ends = [s6, audit, part2].filter((x) => x != null && x > s5);
  ranges.push([s5, ends.length ? Math.min(...ends) : pages.length]);
  return ranges;
}

async function extractPages(buffer, ranges) {
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const total = src.getPageCount();
  const indices = [];
  for (const [start, end] of ranges) {
    for (let i = start; i < end && i < total; i++) indices.push(i);
  }
  const copied = await out.copyPages(src, indices);
  copied.forEach((p) => out.addPage(p));
  return Buffer.from(await out.save());
}

// 上限超のPDFを、有報の必要セクションだけに絞る。
// 返り値: { trimmed: Buffer|null, reason, keptPages? }
//  - trimmed=Buffer: 抜粋成功
//  - reason="image": テキストが無く章を特定できない（画像有報 → NotebookLM推奨）
//  - reason="no-sections": 有報構造を検出できない
export async function trimToRelevantSections(buffer) {
  const pages = await getPerPageText(buffer);
  if (!pages.length || pages.every((p) => !p.trim())) {
    return { trimmed: null, reason: "image" };
  }
  const ranges = findKeepRanges(pages);
  if (!ranges) return { trimmed: null, reason: "no-sections" };

  const trimmed = await extractPages(buffer, ranges);
  const keptPages = ranges.reduce((sum, [a, b]) => sum + (b - a), 0);
  return { trimmed, reason: "trimmed", keptPages };
}
