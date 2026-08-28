const MAX_CRAWL_MS = 45000;
const MAX_INTERACTIONS = 40;
const MAX_OPTIONS_PER_SELECT = 15;
// 1ページから拾う候補の上限。ここでは絞り込まず、全ページ分をまとめてから
// 呼び出し側（collect-local）が種別と新しさで選ぶ。
const MAX_CANDIDATES = 400;
const SETTLE_TIMEOUT_MS = 8000;

const YEAR_OR_PERIOD_LIKE =
  /(19|20)\d{2}\s*年|第[一二三四五六七八九1-9１-９]+四半期|通期|前期|今期|H\d{2}|FY ?\d{2,4}/;

const PLACEHOLDER_OPTION = /^(選択|please\s*select|--|全て|すべて)/i;

// 既存 /api/collect と同じ、生HTML文字列から埋め込みPDFリンクを拾う正規表現フォールバック
const EMBEDDED_PDF_PATTERN = /["'(]([^"'()\s]+?\.pdf(?:\?[^"'()\s]*)?)["')]/gi;

function fileNameOf(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() || url);
  } catch {
    return url;
  }
}

// PDFの置き場（ディレクトリ）。セクション見出しが無いページでの種別の代わりに使う。
// 例: .../pdf/tanshin/5801.pdf → .../pdf/tanshin
function dirOf(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/\/[^/]*$/, "");
  } catch {
    return "";
  }
}

// ページ内で各PDFリンクの「意味のあるラベル」と「所属セクション」を組み立てる。
// IR資料室はリンク文字が「1,293KB」のようなファイルサイズだけのことが多く、
// アンカー文字だけでは種別も決算期も分からない。表の行見出し・列見出し・直前の
// 見出しから文脈を拾うことで、「決算説明資料 2026年度（第58期） 第1四半期 Q＆A」のような
// ラベルを作る。
function extractAnchorsInPage() {
  const JUNK =
    /^(pdf|new|新しいウィンドウで開く|別ウィンドウ|ダウンロード|詳細|こちら|開く|表示|[\d,.]+\s*(kb|mb|gb|bytes?|バイト))$/i;
  const clean = (el) => (el ? (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim() : "");
  // 空欄を表す記号だけのセル（「-」「―」「－」「・」など）はラベルに入れない
  const EMPTY_CELL = /^[-–—―－ー‐・．.\s]*$/;

  // 直前にある見出しを探す（そのリンクが属するセクション名）
  function sectionOf(a) {
    let el = a;
    while (el) {
      let p = el.previousElementSibling;
      while (p) {
        if (p.matches && p.matches("h1,h2,h3,h4,h5,h6")) return clean(p);
        const inner = p.querySelector && p.querySelector("h1,h2,h3,h4,h5,h6");
        if (inner) return clean(inner);
        p = p.previousElementSibling;
      }
      el = el.parentElement;
    }
    return "";
  }

  // 表の中なら、行見出し（左のセル）と列見出し（先頭行の同じ列）を拾う。
  // rowspan/colspan があるので、素直な cellIndex ではなくグリッドを組み立てて位置を求める。
  function tableContextOf(a) {
    const cell = a.closest("td,th");
    const table = cell && cell.closest("table");
    if (!cell || !table) return "";

    const grid = [];
    [...table.rows].forEach((tr, r) => {
      let c = 0;
      [...tr.cells].forEach((cl) => {
        while (grid[r] && grid[r][c]) c++;
        const rs = cl.rowSpan || 1;
        const cs = cl.colSpan || 1;
        for (let i = 0; i < rs; i++) {
          for (let j = 0; j < cs; j++) {
            grid[r + i] = grid[r + i] || [];
            grid[r + i][c + j] = cl;
          }
        }
        c += cs;
      });
    });

    let pos = null;
    for (let r = 0; r < grid.length && !pos; r++) {
      const row = grid[r] || [];
      for (let c = 0; c < row.length; c++) {
        if (row[c] === cell) {
          pos = { r, c };
          break;
        }
      }
    }
    if (!pos) return "";

    const parts = [];
    const seen = new Set([cell]);
    // 行の左側セル（決算期・「資料」「Q＆A」など）
    for (let c = 0; c < pos.c; c++) {
      const left = grid[pos.r][c];
      if (!left || seen.has(left)) continue;
      seen.add(left);
      if (left.querySelector && left.querySelector('a[href*=".pdf"]')) continue;
      const t = clean(left);
      if (t && !EMPTY_CELL.test(t)) parts.push(t);
    }
    // 列見出し（第1四半期 など）
    const head = grid[0] && grid[0][pos.c];
    if (head && !seen.has(head)) {
      const t = clean(head);
      if (t && !EMPTY_CELL.test(t)) parts.push(t);
    }
    return parts.join(" ");
  }

  return [...document.querySelectorAll("a[href]")]
    .filter((el) => ((el.getAttribute("href") || "").toLowerCase().includes(".pdf")))
    .map((el) => {
      const own = clean(el);
      const useful = own && !JUNK.test(own) ? own : "";
      return {
        href: el.getAttribute("href"),
        text: useful,
        title: el.getAttribute("title") || "",
        section: sectionOf(el),
        context: tableContextOf(el),
      };
    });
}

async function collectPdfLinksFromDom(page, pageUrl, foundMap) {
  const anchors = await page.evaluate(extractAnchorsInPage).catch(() => []);

  for (const a of anchors) {
    if (!a.href) continue;
    let absolute;
    try {
      absolute = new URL(a.href, pageUrl).href;
    } catch {
      continue;
    }
    // 「セクション名 + 表の文脈 + アンカー文字」を連結して、種別と決算期が読み取れるラベルにする
    const label =
      [a.section, a.context, a.text || a.title].filter(Boolean).join(" ").trim() ||
      fileNameOf(absolute);
    const group = a.section || dirOf(absolute);
    const existing = foundMap.get(absolute);
    if (!existing || label.length > existing.label.length) {
      foundMap.set(absolute, { label, group });
    }
  }

  const html = await page.content();
  let match;
  EMBEDDED_PDF_PATTERN.lastIndex = 0;
  while ((match = EMBEDDED_PDF_PATTERN.exec(html)) !== null) {
    const candidate = match[1].replace(/\\\//g, "/");
    let absolute;
    try {
      absolute = new URL(candidate, pageUrl).href;
    } catch {
      continue;
    }
    if (!foundMap.has(absolute)) {
      foundMap.set(absolute, { label: fileNameOf(absolute), group: dirOf(absolute) });
    }
  }
}

async function waitForContentSettle(page, timeoutMs = SETTLE_TIMEOUT_MS) {
  const previousPdfAnchorCount = await page
    .$$eval('a[href*=".pdf"]', (els) => els.length)
    .catch(() => 0);

  await Promise.race([
    page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {}),
    page
      .waitForFunction(
        (prevCount) => document.querySelectorAll('a[href*=".pdf"]').length !== prevCount,
        previousPdfAnchorCount,
        { timeout: timeoutMs }
      )
      .catch(() => {}),
  ]);
  await page.waitForTimeout(300);
}

async function discoverInteractionTargets(page) {
  const targets = [];

  const selectHandles = await page.$$("select");
  for (const selectEl of selectHandles) {
    const options = await selectEl.$$eval("option", (opts) =>
      opts.map((o) => ({ value: o.value, label: (o.textContent || "").trim() }))
    );
    const usable = options.filter((o) => o.value !== "" && !PLACEHOLDER_OPTION.test(o.label));
    if (usable.length > 0) {
      targets.push({ type: "select", el: selectEl, options: usable.slice(0, MAX_OPTIONS_PER_SELECT) });
    }
  }

  const clickCandidates = await page.$$eval(
    '[role="tab"], [class*="tab"], [class*="accordion"], [class*="year"], button, a[href="#"], a[href^="javascript"]',
    (els) =>
      els.map((el, i) => ({
        i,
        text: (el.textContent || "").trim(),
      }))
  );

  const matchingIndexes = clickCandidates
    .filter((c) => c.text && YEAR_OR_PERIOD_LIKE.test(c.text))
    .slice(0, MAX_INTERACTIONS);

  if (matchingIndexes.length > 0) {
    const clickHandles = await page.$$(
      '[role="tab"], [class*="tab"], [class*="accordion"], [class*="year"], button, a[href="#"], a[href^="javascript"]'
    );
    for (const m of matchingIndexes) {
      const el = clickHandles[m.i];
      if (el) targets.push({ type: "click", el, label: m.text });
    }
  }

  return targets;
}

// 「人間の操作を再現する」汎用クロール。
// select/tab/accordionらしき要素を機械的に見つけて全て試し、都度PDFリンクを再収集する。
// 該当する要素が無いページ（静的一覧ページ）では自然に何もせず、初回収集だけで終わる。
// IR資料が置かれていそうなサブページを1階層だけ辿る。
// クローラーは指定ページ内しか見ていなかったので、質疑応答や説明会資料が
// 「決算説明会」「IRライブラリ」などの別ページにある会社では取りこぼしていた。
const SUBPAGE_HINT =
  /(質疑|Q\s*&\s*A|Ｑ＆Ａ|説明会|決算|短信|有価証券|報告書|IR\s*ライブラリ|IR資料|ライブラリ|library|presentation|briefing|financial|results)/i;
// 資料ではないページ（会社概要・採用・お問い合わせ等）は辿らない
const SUBPAGE_DENY = /(recruit|contact|privacy|sitemap|company|about|news\/?$|englishtop)/i;
const MAX_SUBPAGES = 6;

async function discoverSubPages(page, pageUrl) {
  const origin = new URL(pageUrl).origin;
  const links = await page
    .$$eval("a[href]", (els) =>
      els.map((el) => ({ href: el.getAttribute("href") || "", text: (el.innerText || "").trim() }))
    )
    .catch(() => []);

  const out = [];
  const seen = new Set([pageUrl.replace(/#.*$/, "")]);
  for (const l of links) {
    if (!l.href || l.href.toLowerCase().includes(".pdf")) continue;
    let abs;
    try {
      abs = new URL(l.href, pageUrl).href.replace(/#.*$/, "");
    } catch {
      continue;
    }
    if (!abs.startsWith(origin) || seen.has(abs)) continue;
    const hay = `${l.text} ${abs}`;
    if (!SUBPAGE_HINT.test(hay) || SUBPAGE_DENY.test(abs)) continue;
    seen.add(abs);
    out.push(abs);
    if (out.length >= MAX_SUBPAGES) break;
  }
  return out;
}

export async function crawlForPdfLinks(page, pageUrl) {
  const startTime = Date.now();
  const foundMap = new Map();
  let interactionCount = 0;
  let timedOut = false;

  try {
    await page.goto(pageUrl, { waitUntil: "networkidle", timeout: 30000 });
  } catch {
    try {
      await page.goto(pageUrl, { waitUntil: "load", timeout: 30000 });
      await page.waitForTimeout(1000);
    } catch (e) {
      throw new Error(`ページを開けません（${e.message}）`);
    }
  }

  await collectPdfLinksFromDom(page, pageUrl, foundMap);

  const targets = await discoverInteractionTargets(page);

  outer: for (const target of targets) {
    if (foundMap.size >= MAX_CANDIDATES) break;

    if (target.type === "select") {
      for (const option of target.options) {
        if (Date.now() - startTime > MAX_CRAWL_MS) {
          timedOut = true;
          break outer;
        }
        if (interactionCount >= MAX_INTERACTIONS || foundMap.size >= MAX_CANDIDATES) break outer;

        try {
          await target.el.selectOption(option.value);
        } catch {
          continue;
        }
        await waitForContentSettle(page);
        await collectPdfLinksFromDom(page, pageUrl, foundMap);
        interactionCount++;
      }
    } else {
      if (Date.now() - startTime > MAX_CRAWL_MS) {
        timedOut = true;
        break;
      }
      if (interactionCount >= MAX_INTERACTIONS || foundMap.size >= MAX_CANDIDATES) break;

      await target.el.click({ timeout: 5000 }).catch(() => {});
      await waitForContentSettle(page);
      await collectPdfLinksFromDom(page, pageUrl, foundMap);
      interactionCount++;
    }
  }

  // 指定ページで見つからなかった資料がサブページにあることが多い
  // （「決算説明会」「IRライブラリ」など）。時間と件数に余裕があるときだけ辿る。
  let subPagesVisited = 0;
  if (!timedOut && foundMap.size < MAX_CANDIDATES && Date.now() - startTime < MAX_CRAWL_MS * 0.6) {
    const subPages = await discoverSubPages(page, pageUrl);
    for (const sub of subPages) {
      if (Date.now() - startTime > MAX_CRAWL_MS || foundMap.size >= MAX_CANDIDATES) {
        timedOut = true;
        break;
      }
      try {
        await page.goto(sub, { waitUntil: "domcontentloaded", timeout: 15000 });
        await waitForContentSettle(page, 4000);
        await collectPdfLinksFromDom(page, sub, foundMap);
        subPagesVisited++;
      } catch {
        // 開けないサブページは飛ばす
      }
    }
  }

  // 絞り込みはここでは行わない。複数URLを渡されたとき、1ページ目だけで
  // 全体の上限を使い切ってしまうため、候補は全部返して呼び出し側で
  // 全ページ分をまとめてから選ぶ。
  const candidates = Array.from(foundMap, ([url, v]) => ({ url, label: v.label, group: v.group }));
  return {
    links: candidates,
    interactionsPerformed: interactionCount,
    subPagesVisited,
    timedOut,
    candidateCount: candidates.length,
    groupCount: new Set(candidates.map((c) => c.group)).size,
  };
}
