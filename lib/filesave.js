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

export function getCompanyDir(companyName) {
  return path.join(os.homedir(), "Documents", "IR資料", sanitize(companyName));
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
