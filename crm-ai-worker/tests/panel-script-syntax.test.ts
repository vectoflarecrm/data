/* 面板模板字符串回归测试（b4dd670 事故）：
 * admin.ts 的面板 HTML 写在 TS 模板字符串里，模板里的 `\n` 等转义序列会在
 * 求值后变成真实字符进入 <script> —— confirm('\n') 曾变成跨行字符串字面
 * 量，浏览器整段脚本 SyntaxError，/admin/crm 所有列表空白（数据完好，纯
 * 前端解析失败）。tsc/tests 都不检查模板内部的 JS，这里补上：按运行时语
 * 义求值每个面板模板，对其中每个 <script> 块做 JS 语法解析。 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "src", "admin.ts"), "utf8");

const PANEL_NAMES = [
  "ADMIN_LOGIN_HTML",
  "ADMIN_PANEL_HTML",
  "OUTREACH_PANEL_HTML",
  "KEYS_PANEL_HTML",
  "AUDIT_PANEL_HTML",
  "SESSIONS_PANEL_HTML",
  "CRM_PANEL_HTML",
  "SECURITY_PANEL_HTML",
] as const;

/** 按模板字符串运行时语义求值（转义序列生效 = 浏览器实际收到的 HTML）。 */
function evaluatedTemplate(name: string): string {
  const re = new RegExp("const " + name + " = `([^`]*)`");
  const m = re.exec(src);
  if (!m) throw new Error("panel template not found in src/admin.ts: " + name);
  // eslint-disable-next-line no-eval
  return (0, eval)("`" + m[1] + "`") as string;
}

function scriptBlocks(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    .map((s) => s[1])
    .filter((s) => s.trim().length > 0);
}

describe("panel template <script> stays valid JavaScript after template evaluation", () => {
  it("found every panel template", () => {
    for (const name of PANEL_NAMES) {
      expect(() => evaluatedTemplate(name)).not.toThrow();
    }
  });

  for (const name of PANEL_NAMES) {
    it(`${name}: every <script> block parses`, () => {
      const html = evaluatedTemplate(name);
      const scripts = scriptBlocks(html);
      // ADMIN_LOGIN_HTML 是纯表单页（无脚本）；其余面板必须内嵌脚本
      if (name === "ADMIN_LOGIN_HTML") {
        for (const js of scripts) {
          expect(() => new Function(js), `${name} script block failed to parse`).not.toThrow();
        }
        return;
      }
      expect(scripts.length).toBeGreaterThan(0);
      for (const js of scripts) {
        expect(() => new Function(js), `${name} script block failed to parse`).not.toThrow();
      }
    });
  }
});
