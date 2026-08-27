import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

const ILLEGAL_CHARS = /[/\\:*?"<>|]/g;

export function sanitize(name) {
  return (name || "")
    .replace(ILLEGAL_CHARS, "_")
    .replace(/\s+/g, " ")
    .trim();
}

// 収集したPDF・要約・分析の保存先ルート。
// ~/Documents と ~/Downloads は macOS のプライバシー保護(TCC)の対象で、
// launchd から常駐起動したプロセスからは読めない（EPERM）。
// 常駐させたまま使えるよう、保護対象外の ~/IR資料 を既定にしている。
// 別の場所に置きたいときは環境変数 IR_DATA_DIR で上書きできる。
export const IR_ROOT = process.env.IR_DATA_DIR || path.join(os.homedir(), "IR資料");

export function getCompanyDir(companyName) {
  return path.join(IR_ROOT, sanitize(companyName));
}

export function buildFileName(companyName, fiscalYear, quarter, docType) {
  const safeCompany = sanitize(companyName);
  const fy = sanitize(fiscalYear || "年度不明");
  const label = sanitize(`${quarter || ""}${docType || "資料"}`);
  return `${safeCompany}_${fy}_${label}.pdf`;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// PDFを分類結果に基づいて企業フォルダに保存する。
// 既存の同名ファイルがあれば内容ハッシュを比較し、同一ならスキップ、異なれば衝突回避のサフィックスを付ける。
// 分類が不明な場合は _unclassified/ に元のファイル名のまま保存する。
export function saveDocument({ buffer, companyName, fiscalYear, quarter, docType, sourceUrl }) {
  const companyDir = getCompanyDir(companyName);
  const isUnclassified = !docType || docType === "不明" || !fiscalYear || fiscalYear === "不明";

  let targetDir = companyDir;
  let fileName;

  if (isUnclassified) {
    targetDir = path.join(companyDir, "_unclassified");
    fileName = fileNameFromUrl(sourceUrl) || `unclassified_${sha256(buffer).slice(0, 6)}.pdf`;
  } else {
    fileName = buildFileName(companyName, fiscalYear, quarter, docType);
  }

  const result = writeWithDedup(targetDir, fileName, buffer);
  return { ...result, unclassified: isUnclassified };
}

// 証券会社レポートなど、ユーザーが手動で足す参考資料を {会社名}/_参考資料/ に保存する。
// 年度分類はできない前提なので、元のファイル名のまま保存する。
export function saveReferenceDocument({ buffer, companyName, sourceUrl }) {
  const targetDir = path.join(getCompanyDir(companyName), "_参考資料");
  const fileName = fileNameFromUrl(sourceUrl) || `参考資料_${sha256(buffer).slice(0, 6)}.pdf`;
  const result = writeWithDedup(targetDir, fileName, buffer);
  return { ...result, reference: true };
}

// 会社フォルダ内の索引ファイル。取り込んだPDFの「取得元URL → 保存先パス」を記録し、
// 2回目以降の取り込みで同じURLを再ダウンロードせずローカルから流用するために使う。
function indexPath(companyName) {
  return path.join(getCompanyDir(companyName), "_index.json");
}

function readIndex(companyName) {
  try {
    const raw = fs.readFileSync(indexPath(companyName), "utf8");
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

// 取得元URLに対応する既存の保存済みPDFのパスを返す（ファイルが実在する場合のみ）。
// 見つからなければ null。これが返れば、呼び出し側は再ダウンロードせずローカルを読める。
// その会社フォルダに既に取り込み済みの取得元URL一覧。
// 会社名を変え忘れて別会社の資料を混ぜる事故を検知するために使う。
export function getIndexedUrls(companyName) {
  return Object.keys(readIndex(companyName));
}

export function getSavedPathForUrl(companyName, sourceUrl) {
  if (!sourceUrl) return null;
  const entry = readIndex(companyName)[sourceUrl];
  if (entry && entry.path && fs.existsSync(entry.path)) return entry.path;
  return null;
}

// 取り込み結果を索引に記録する（新規保存・既存スキップのどちらでも呼んで索引を最新に保つ）。
export function recordInIndex(companyName, sourceUrl, savedPath, meta = {}) {
  if (!sourceUrl || !savedPath) return;
  try {
    const idx = readIndex(companyName);
    idx[sourceUrl] = { path: savedPath, updatedAt: new Date().toISOString(), ...meta };
    fs.mkdirSync(getCompanyDir(companyName), { recursive: true });
    fs.writeFileSync(indexPath(companyName), JSON.stringify(idx, null, 2));
  } catch {
    // 索引の書き込み失敗は致命的ではないので握りつぶす（次回また記録される）。
  }
}

function fileNameFromUrl(sourceUrl) {
  try {
    return sanitize(decodeURIComponent(path.basename(new URL(sourceUrl).pathname)));
  } catch {
    return "";
  }
}

// 保存先にファイルを書き込む。同名ファイルが既にあれば内容ハッシュを比較し、
// 同一ならスキップ、異なれば末尾に短いハッシュを付けて衝突を避ける。
function writeWithDedup(targetDir, fileName, buffer) {
  fs.mkdirSync(targetDir, { recursive: true });
  let targetPath = path.join(targetDir, fileName);
  const newHash = sha256(buffer);

  if (fs.existsSync(targetPath)) {
    const existingHash = sha256(fs.readFileSync(targetPath));
    if (existingHash === newHash) {
      return { skipped: true, path: targetPath, reason: "already exists" };
    }
    const ext = path.extname(fileName);
    const base = fileName.slice(0, -ext.length);
    fileName = `${base}__${newHash.slice(0, 6)}${ext}`;
    targetPath = path.join(targetDir, fileName);
  }

  fs.writeFileSync(targetPath, buffer);
  return { skipped: false, path: targetPath };
}
