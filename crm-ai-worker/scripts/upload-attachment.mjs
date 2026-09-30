#!/usr/bin/env node
/* 上传开发信附件（画册）到 CRM Worker 的 D1，并打语言标签。
 *
 * 用法：
 *   node scripts/upload-attachment.mjs <PDF文件> <品牌名> <语言代码> [面板地址] [面板Token]
 *
 * 示例（西班牙语画册 → Afarer）：
 *   node scripts/upload-attachment.mjs "/media/hello/boot/Inflatable SUP_es.pdf" Afarer es \
 *     https://crm-ai-worker.qdu.workers.dev "$ADMIN_PANEL_TOKEN"
 *
 * 语言代码：es=西班牙语 en=英语 de=德语 fr=法语 pt=葡萄牙语 it=意大利语 …
 *           all=通用（所有客户都带，无论语言）
 *
 * 面板地址与 Token 也可用环境变量：ADMIN_BASE_URL / ADMIN_PANEL_TOKEN
 * 发送时西班牙语客户自动带 es 附件，其他语言客户带通用（all）附件。
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const [fileArg, brandArg, langArg, urlArg, tokenArg] = process.argv.slice(2);

const file = fileArg || process.env.ATTACHMENT_FILE;
const brand = brandArg || process.env.ATTACHMENT_BRAND;
const language = (langArg || process.env.ATTACHMENT_LANGUAGE || "all").trim().toLowerCase();
const baseUrl = (urlArg || process.env.ADMIN_BASE_URL || "").replace(/\/+$/, "");
const token = tokenArg || process.env.ADMIN_PANEL_TOKEN;

if (!file || !brand || !baseUrl || !token) {
  console.error(`用法: node scripts/upload-attachment.mjs <PDF文件> <品牌名> <语言代码> <面板地址> <面板Token>
  或设置环境变量: ATTACHMENT_FILE ATTACHMENT_BRAND ATTACHMENT_LANGUAGE ADMIN_BASE_URL ADMIN_PANEL_TOKEN
示例:
  node scripts/upload-attachment.mjs "/media/hello/boot/Inflatable SUP_es.pdf" Afarer es \\
    https://crm-ai-worker.qdu.workers.dev "\$ADMIN_PANEL_TOKEN"`);
  process.exit(1);
}

if (language !== "all" && !/^[a-z]{2,3}$/.test(language)) {
  console.error(`无效语言代码 "${language}"：用 2-3 位 ISO 代码（如 es）或 all`);
  process.exit(1);
}

const data = await readFile(file);
if (data.byteLength === 0) { console.error("文件为空"); process.exit(1); }
if (data.byteLength > 1_400_000) {
  console.error(`文件 ${(data.byteLength / 1024 / 1024).toFixed(2)} MB 超过 D1 的 1.4 MB 限制`);
  process.exit(1);
}
const contentBase64 = data.toString("base64");

const resp = await fetch(`${baseUrl}/admin/api/outreach/attachments`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({
    brand,
    filename: basename(file),
    mime_type: file.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream",
    content_base64: contentBase64,
    language,
  }),
});

const body = await resp.text();
if (!resp.ok) {
  console.error(`上传失败 HTTP ${resp.status}: ${body}`);
  process.exit(1);
}
console.log(`✅ 已上传 ${basename(file)} (${(data.byteLength / 1024).toFixed(0)} KB) → 品牌 ${brand}，语言 ${language}`);
console.log(`   ${language === "all" ? "所有客户都会收到此附件" : `收件语言为 ${language} 的客户会收到此附件`}`);
