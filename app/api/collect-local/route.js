import fs from "fs";
import { crawlForPdfLinks } from "../../../lib/crawler.js";
import { classifyFromLabel, classifyBatchWithClaude } from "../../../lib/classify.js";
import {
  saveDocument,
  saveReferenceDocument,
  getCompanyDir,
  getSavedPathForUrl,
  getIndexedUrls,
  recordInIndex,
} from "../../../lib/filesave.js";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_PDFS_TOTAL = 48;
// 取り込む決算期の下限の既定値。直近4期あれば推移は追えるので、それより前は取り込まない。
export const DEFAULT_MIN_FISCAL_YEAR = new Date().getFullYear() - 3;
const MAX_CHARS_PER_PDF = 30000;
const CLASSIFY_TEXT_CHARS = 3000;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

async function downloadPdf(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`ダウンロード失敗（ステータス ${res.status}）`);
  return Buffer.from(await res.arrayBuffer());
}

async function extractPdfText(buffer) {
  const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
  const parsed = await pdfParse(buffer);
  const text = (parsed.text || "").replace(/\n{3,}/g, "\n\n").trim();
  return { text, pages: parsed.numpages || 0 };
}

// 決算期の新しさを比較できる数値にする。「2027年3月期 第1四半期」→ 20271。
// 「第58期」のように年ではなく期番号で書かれるサイトもあるので、その場合は別レンジに寄せる
// （同じ会社なら表記は揃うので、グループ内の並べ替えには十分）。
function periodRank(fiscalYear, quarter) {
  const fy = fiscalYear || "";
  let base = 0;
  const y = fy.match(/((?:19|20)\d{2})年/);
  if (y) base = Number(y[1]);
  else {
    const term = fy.match(/第\s*(\d{1,3})\s*期/);
    if (term) base = 1000 + Number(term[1]);
  }
  const q = quarter || "";
  const qRank = q === "通期" ? 4 : /第3/.test(q) ? 3 : /第2|中間/.test(q) ? 2 : /第1/.test(q) ? 1 : 0;
  return base * 10 + qRank;
}

// 取り込む資料を選ぶ。ダウンロードする前に、ラベルだけで種別と決算期を判定して選別する
// （ラベル判定はLLMもダウンロードも使わないので無料）。
//
// 2つの事故を防ぐのが目的：
//  1. URLを複数渡したとき、1ページ目（決算短信一覧など）だけで枠を使い切り、
//     2ページ目以降の決算説明資料・有価証券報告書が1件も入らない。
//     → 全URLの候補をまとめてから、種別ごとに順ぐりに取る。
//  2. 一覧が古い順に並んでいるサイトで、20年以上前の資料で枠が埋まる。
//     → 各種別の中で決算期の新しい順に並べ替えてから取る。
// 決算期から、下限年と比較できる西暦を取り出す（「第76期」のように西暦が無い表記なら null）。
function fiscalYearNumber(fiscalYear) {
  const fy = fiscalYear || "";
  const kessanki = fy.match(/((?:19|20)\d{2})年\s*\d{1,2}\s*月期/);
  if (kessanki) return Number(kessanki[1]);
  // 「2025年度」は3月決算なら2026年3月期。下限年は決算期で指定してもらうので+1して揃える。
  // 12月決算などでは1年ぶん甘くなるが、必要な資料を落とすよりは安全側に倒す。
  const nendo = fy.match(/((?:19|20)\d{2})\s*年度/);
  if (nendo) return Number(nendo[1]) + 1;
  const other = fy.match(/((?:19|20)\d{2})年/);
  return other ? Number(other[1]) : null;
}

// 決算期が「第64期」のように西暦を持たない資料でも、ラベルに載っている
// 開示日（2026.06.24 / 2026年6月24日 など）から年を拾えることが多い。
// これが無いと、関連ページまで辿るようになってから古い四半期報告書が
// 年の足切りをすり抜けて大量に入ってしまう。
function labelYear(label) {
  const m = (label || "").match(/((?:19|20)\d{2})[.\-/年]\s*\d{1,2}[.\-/月]/);
  return m ? Number(m[1]) : null;
}

function selectDocuments(candidates, limit, minFiscalYear) {
  const groups = new Map();
  const skippedOld = [];
  candidates.forEach((c, domIndex) => {
    const { docType, fiscalYear, quarter } = classifyFromLabel(c.label);

    // 古い資料の足切り。決算期を読み取れないものは判断できないので残す
    // （読み取れないものを落とすと、決算期が書かれていない質疑応答などを取りこぼす）。
    // ただしラベルに開示日があるなら、それを決算期の代わりに使う。
    const fyNum = fiscalYearNumber(fiscalYear) ?? labelYear(c.label);
    if (minFiscalYear && fyNum !== null && fyNum < minFiscalYear) {
      skippedOld.push(c);
      return;
    }
    // 種別を判定できないものは、ページ上の並び（グループ）でまとめる
    const key = docType || `その他:${c.group || ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...c, docType, rank: periodRank(fiscalYear, quarter), domIndex });
  });

  for (const list of groups.values()) {
    list.sort((a, b) => b.rank - a.rank || a.domIndex - b.domIndex);
  }

  // 種別が判定できたものを先に埋め、余った枠だけを種別不明にまわす。
  // 混ぜて順ぐりにすると、種別不明の古い資料（リンク名に種別が書かれていない
  // 20年前の短信など）が枠の半分近くを持っていってしまう。
  const typed = [...groups.entries()].filter(([k]) => !k.startsWith("その他:")).map(([, v]) => v);
  const untyped = [...groups.entries()].filter(([k]) => k.startsWith("その他:")).map(([, v]) => v);

  const out = [];
  const roundRobin = (lists) => {
    let i = 0;
    while (out.length < limit && lists.some((l) => l.length > 0)) {
      const list = lists[i % lists.length];
      if (list.length > 0) out.push(list.shift());
      i++;
    }
  };
  roundRobin(typed);
  roundRobin(untyped);
  return { picked: out, skippedOld: skippedOld.length };
}

// URLが直接PDFを指しているか（証券会社レポートの直リンクなど）。
// その場合はクロールせず、そのまま1件の参考資料として取り込む。
function isDirectPdf(url) {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

export async function POST(request) {
  if (process.env.VERCEL) {
    return Response.json(
      { error: "このAPIはVercel上では実行できません。ローカル（npm run dev / npm start）で実行してください。" },
      { status: 501 }
    );
  }

  let browser;
  try {
    const {
      companyName,
      tickerCode,
      urls,
      minFiscalYear: minFyRaw,
      confirmDifferentSite,
      onlyStandardTypes = true,
    } = await request.json();

    // 「◯年3月期より前は取り込まない」。
    // 画面から値が来なかったとき（古いタブが開いたまま等）は既定値を使う。
    // 空文字が来たときだけ「制限なし」。指定が届かないと20年分の古い資料を
    // 取り込んでしまうので、無指定を制限なし扱いにはしない。
    const minFiscalYear =
      minFyRaw === undefined || minFyRaw === null
        ? DEFAULT_MIN_FISCAL_YEAR
        : Number(minFyRaw) > 1900
        ? Math.floor(Number(minFyRaw))
        : null;

    const company = (companyName || "").trim();
    if (!company) {
      return Response.json({ error: "会社名を入力してください" }, { status: 400 });
    }

    const targets = (urls || [])
      .map((u) => (u || "").trim())
      .filter((u) => u.startsWith("http"));

    if (targets.length === 0) {
      return Response.json(
        { error: "URLを1つ以上入力してください（httpから始まるもの）" },
        { status: 400 }
      );
    }

    // 会社名の変え忘れ検知。既にこの会社フォルダに入っている資料の取得元ドメインと、
    // 今回のURLのドメインがまったく重ならないときは、いったん止めて確認する。
    // （メック↔NISSO、東洋合成↔日本電子材料のように、別会社の資料が同じフォルダに
    //   混ざると要約・分析が別会社の内容になってしまう）
    if (!confirmDifferentSite) {
      const hostOf = (u) => {
        try {
          return new URL(u).hostname.replace(/^www\./, "");
        } catch {
          return "";
        }
      };
      const known = new Set(getIndexedUrls(company).map(hostOf).filter(Boolean));
      const incoming = [...new Set(targets.map(hostOf).filter(Boolean))];
      if (known.size > 0 && incoming.length > 0 && !incoming.some((h) => known.has(h))) {
        return Response.json(
          {
            error:
              `「${company}」のフォルダには ${[...known].join("・")} の資料が入っていますが、` +
              `今回のURLは ${incoming.join("・")} です。会社名が前のままになっていませんか？`,
            needsConfirm: "differentSite",
          },
          { status: 409 }
        );
      }
    }

    const pdfTargets = targets.filter(isDirectPdf);
    const pageTargets = targets.filter((u) => !isDirectPdf(u));

    const notes = [];
    let allLinks = [];

    // IR一覧ページはブラウザで巡回する（直リンクPDFしか無ければ起動しない）
    if (pageTargets.length > 0) {
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ userAgent: UA });

      for (const target of pageTargets) {
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        try {
          const { links, interactionsPerformed, subPagesVisited, timedOut } = await crawlForPdfLinks(page, target);
          if (links.length === 0) {
            notes.push(`${target} … PDFリンクが見つかりませんでした`);
          } else {
            notes.push(
              `${target} … ${links.length}件のPDFを発見（操作${interactionsPerformed}回${
                subPagesVisited ? `・関連ページ${subPagesVisited}件も確認` : ""
              }${timedOut ? "・時間切れで打ち切り" : ""}）`
            );
            // ここでは上限で切らない。1ページ目だけで枠を使い切ると、
            // 2ページ目以降の資料が1件も入らなくなるため。
            for (const link of links) {
              if (!allLinks.some((l) => l.url === link.url)) allLinks.push(link);
            }
          }
        } catch (e) {
          notes.push(`${target} … 取得失敗（${e.message}）`);
        } finally {
          await page.close().catch(() => {});
        }
      }

      await browser.close();
      browser = null;
    }

    // PDFの直リンク（クローラが漏らした資料の手動追加、証券会社レポートなど）も
    // クロールで拾ったものと同じ列に並べ、以降まったく同じ分類処理に通す。
    // ユーザーが明示的に指定したものなので、クロール分の上限では削らない。
    for (const url of pdfTargets) {
      const label = decodeURIComponent(url.split("/").pop().split("?")[0]) || url;
      if (!allLinks.some((l) => l.url === url)) allLinks.push({ url, label, direct: true });
    }

    if (allLinks.length === 0) {
      return Response.json({ error: "PDFリンクが見つかりませんでした", notes }, { status: 404 });
    }

    // 全URL分の候補がそろってから、種別ごとに新しい順で取り込む分を選ぶ。
    // 直リンク指定は明示的な指示なので、必ず残す。
    const directLinks = allLinks.filter((l) => l.direct);
    const crawledLinks = allLinks.filter((l) => !l.direct);
    const { picked, skippedOld } = selectDocuments(
      crawledLinks,
      Math.max(0, MAX_PDFS_TOTAL - directLinks.length),
      minFiscalYear
    );
    if (skippedOld > 0) {
      notes.push(`${minFiscalYear}年3月期より前の資料${skippedOld}件は設定により取り込みません`);
    }
    if (crawledLinks.length - skippedOld > picked.length) {
      const kinds = [...new Set(picked.map((p) => p.docType).filter(Boolean))];
      notes.push(
        `候補${crawledLinks.length - skippedOld}件から${picked.length}件を選びました` +
          `（種別ごとに決算期の新しい順${kinds.length ? "：" + kinds.join("・") : ""}）。` +
          `足りない資料があれば、そのPDFのURLを直接URL欄に貼ると必ず取り込みます。`
      );
    }
    allLinks = [...directLinks, ...picked];

    // 1. まずダウンロード＋ラベルベースの決定的分類（LLM不要）
    let items = [];
    for (const link of allLinks) {
      try {
        // 2回目以降：同じURLを取り込み済みなら、再ダウンロードせずローカルのPDFを読む。
        const cachedPath = getSavedPathForUrl(company, link.url);
        let buffer;
        let fromCache = false;
        if (cachedPath) {
          buffer = fs.readFileSync(cachedPath);
          fromCache = true;
        } else {
          buffer = await downloadPdf(link.url);
        }
        const { text, pages } = await extractPdfText(buffer);
        // テキストが取れない画像PDF（有価証券報告書のスキャン等）でも、
        // ファイル収集が主目的なので保存はする（NotebookLM等は画像PDFも読める）。
        // 種別の判定はPDF自身の中身を第一の根拠にする。
        // ページのリンク文字は、サイトの作りによっては全リンクが同じ文言に化ける
        // （じげんのIRニュース一覧では48件すべてが「質疑応答」と判定された）。
        // 表紙に「2027年3月期 第1四半期 決算短信」と書いてあるPDF自身のほうが確かなので、
        // 本文から判定できたらそちらを優先し、読めないときだけラベルに頼る。
        const fromLabel = classifyFromLabel(link.label);
        const fromText = text ? classifyFromLabel((text || "").slice(0, CLASSIFY_TEXT_CHARS)) : null;
        const heuristic =
          fromText && fromText.docType
            ? {
                docType: fromText.docType,
                fiscalYear: fromText.fiscalYear || fromLabel.fiscalYear,
                quarter: fromText.quarter || fromLabel.quarter,
                confidence: fromText.confidence,
                typedFrom: "本文",
              }
            : { ...fromLabel, typedFrom: "ラベル" };
        items.push({
          tempId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          label: link.label,
          url: link.url,
          direct: !!link.direct,
          buffer,
          fromCache,
          text: text || "",
          pages,
          noText: !text,
          textPrefix: (text || "").slice(0, CLASSIFY_TEXT_CHARS),
          ...heuristic,
        });
      } catch (e) {
        notes.push(`${link.label} … 読み取り失敗（${e.message}）`);
      }
    }

    // 2. 低確信度の項目だけをバッチでLLM分類（トークン節約）
    // 本文が取れない画像PDFはLLMでも判定できないので、無駄なトークンを使わないよう除外
    const lowConfidence = items.filter((i) => i.confidence === "low" && !i.noText);
    if (lowConfidence.length > 0) {
      try {
        const results = await classifyBatchWithClaude(
          lowConfidence.map((i) => ({ tempId: i.tempId, label: i.label, textPrefix: i.textPrefix }))
        );
        const byId = new Map(results.map((r) => [r.tempId, r]));
        for (const item of lowConfidence) {
          const r = byId.get(item.tempId);
          if (r) {
            item.docType = r.docType !== "不明" ? r.docType : item.docType;
            item.fiscalYear = r.fiscalYear !== "不明" ? r.fiscalYear : item.fiscalYear;
            item.quarter = r.quarter !== "不明" ? r.quarter : item.quarter;
          }
        }
        if (!process.env.ANTHROPIC_API_KEY) {
          notes.push(`${lowConfidence.length}件は自動判定できませんでした（ANTHROPIC_API_KEY未設定）`);
        }
      } catch (e) {
        notes.push(`LLMによる分類に失敗しました（${e.message}）`);
      }
    }

    // 3. 保存
    const documents = [];
    // 必要な6種類だけに絞る。ここに無い種別（適時開示・株主通信など）は保存しない。
    // 訂正版も除く（本体があれば足りるため）。
    const WANTED_TYPES = new Set([
      "決算短信", "決算説明資料", "有価証券報告書", "中期経営計画", "説明会書き起こし", "質疑応答",
    ]);
    if (onlyStandardTypes) {
      const before = items.length;
      // 同じ「種別＋決算期＋四半期」が大量に並ぶのは、ラベルが化けている兆候。
      // 本文から判定できたものを優先し、1組み合わせにつき1件だけ残す。
      const best = new Map();
      const dropped = [];
      for (const item of items) {
        const asRef = item.direct && !item.docType;
        if (asRef) continue; // 直リンクの参考資料は後段でそのまま通す
        if (!item.docType || !WANTED_TYPES.has(item.docType)) { dropped.push(item); continue; }
        const key = `${item.docType}|${item.fiscalYear || ""}|${item.quarter || ""}`;
        const cur = best.get(key);
        // 本文から判定できたもの＞ラベル判定、同条件なら本文が長いものを採る
        const score = (x) => (x.typedFrom === "本文" ? 1e9 : 0) + (x.text?.length || 0);
        if (!cur || score(item) > score(cur)) {
          if (cur) dropped.push(cur);
          best.set(key, item);
        } else dropped.push(item);
      }
      const keep = new Set([...best.values(), ...items.filter((i) => i.direct && !i.docType)]);
      items = items.filter((i) => keep.has(i));
      if (before !== items.length) {
        notes.push(
          `対象の6種類（決算短信・決算説明資料・有価証券報告書・中期経営計画・説明会書き起こし・質疑応答）に絞り、${before - items.length}件を除外しました`
        );
      }
    }

    for (const item of items) {
      // 直リンクで、かつ種別を判定できなかったものだけ「参考資料」として扱う
      // （証券会社レポートなど、IRの定型資料ではないもの）。
      // 決算短信などと判定できた直リンクは、通常の資料と同じ扱いにする。
      const asReference = item.direct && !item.docType;

      const result = asReference
        ? saveReferenceDocument({
            buffer: item.buffer,
            companyName: company,
            sourceUrl: item.url,
          })
        : saveDocument({
            buffer: item.buffer,
            companyName: company,
            fiscalYear: item.fiscalYear,
            quarter: item.quarter,
            docType: item.docType,
            sourceUrl: item.url,
          });

      if (item.fromCache) {
        notes.push(`${item.label} … 取り込み済みのため再ダウンロードせずローカルから読み込みました`);
      } else if (result.skipped) {
        notes.push(`${item.label} … 既に保存済みのためスキップ`);
      } else if (asReference) {
        const extra = item.noText ? "（画像PDF・本文抽出不可）" : "";
        notes.push(`${item.label} … 種別を判定できないため参考資料として取り込みました${extra}`);
      } else if (item.direct) {
        notes.push(
          `${item.label} … 手動追加を「${item.docType}${
            item.quarter && item.quarter !== "不明" ? "・" + item.quarter : ""
          }」として取り込みました`
        );
      } else if (result.unclassified) {
        const extra = item.noText ? "（画像PDF・本文抽出不可）" : "";
        notes.push(`${item.label} … 種別/決算期を判定できず _unclassified に保存しました${extra}`);
      } else if (item.noText) {
        notes.push(`${item.label} … 保存しました（画像PDFのため本文抽出不可・NotebookLMで読めます）`);
      }

      // 取得元URL→保存先を索引に記録（次回の再ダウンロード回避に使う）
      recordInIndex(company, item.url, result.path, {
        docType: asReference ? "参考資料" : item.docType,
        fiscalYear: item.fiscalYear,
        quarter: item.quarter,
      });

      documents.push({
        id: item.tempId,
        label: item.label,
        url: item.url,
        text: item.text.slice(0, MAX_CHARS_PER_PDF),
        chars: Math.min(item.text.length, MAX_CHARS_PER_PDF),
        pages: item.pages,
        addedAt: new Date().toISOString(),
        docType: asReference ? "参考資料" : item.docType || "不明",
        fiscalYear: asReference ? "-" : item.fiscalYear || "不明",
        quarter: asReference ? "-" : item.quarter || "不明",
        savedPath: result.path,
      });
    }

    return Response.json({
      documents,
      notes,
      savedDir: getCompanyDir(company),
      tickerCode: (tickerCode || "").trim(),
    });
  } catch (e) {
    return Response.json({ error: `エラー: ${e.message}` }, { status: 500 });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
