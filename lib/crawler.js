const MAX_CRAWL_MS = 45000;
const MAX_INTERACTIONS = 40;
const MAX_OPTIONS_PER_SELECT = 15;
const MAX_PDFS_PER_PAGE = 30;
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

async function collectPdfLinksFromDom(page, pageUrl, foundMap) {
  const anchors = await page.$$eval("a[href]", (els) =>
    els.map((el) => ({ href: el.getAttribute("href"), text: (el.textContent || "").trim(), title: el.getAttribute("title") }))
  );

  for (const a of anchors) {
    if (!a.href || !a.href.toLowerCase().includes(".pdf")) continue;
    let absolute;
    try {
      absolute = new URL(a.href, pageUrl).href;
    } catch {
      continue;
    }
    const label = a.text || a.title || fileNameOf(absolute);
    const existing = foundMap.get(absolute);
    if (!existing || (label && label.length > existing.length)) {
      foundMap.set(absolute, label);
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
      foundMap.set(absolute, fileNameOf(absolute));
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
    if (foundMap.size >= MAX_PDFS_PER_PAGE) break;

    if (target.type === "select") {
      for (const option of target.options) {
        if (Date.now() - startTime > MAX_CRAWL_MS) {
          timedOut = true;
          break outer;
        }
        if (interactionCount >= MAX_INTERACTIONS || foundMap.size >= MAX_PDFS_PER_PAGE) break outer;

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
      if (interactionCount >= MAX_INTERACTIONS || foundMap.size >= MAX_PDFS_PER_PAGE) break;

      await target.el.click({ timeout: 5000 }).catch(() => {});
      await waitForContentSettle(page);
      await collectPdfLinksFromDom(page, pageUrl, foundMap);
      interactionCount++;
    }
  }

  const links = Array.from(foundMap, ([url, label]) => ({ url, label })).slice(0, MAX_PDFS_PER_PAGE);
  return { links, interactionsPerformed: interactionCount, timedOut };
}
