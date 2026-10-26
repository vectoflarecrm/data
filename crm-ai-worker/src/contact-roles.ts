/* ⑦ 多角色采购联系人图谱（更新.txt 第 7 项）：按职位关键词推断采购角色。
 *
 * 系统不只是"找到一个邮箱"，而是理解谁负责采购、谁能批准、谁会实际
 * 使用产品（更新.txt）。角色词表：
 *   owner        老板/决策人（CEO、创始人、总经理、董事长…）
 *   procurement  采购（purchasing/procurement/buyer/sourcing/采购/供应链…）
 *   finance      财务（CFO/finance/account/财务/会计…）
 *   channel      渠道负责人（channel/partnership/dealership/渠道/经销…）
 *   operations   运营（operations/production/logistics/运营/生产/物流…）
 *   sales        销售（sales/BD/account manager/销售/商务…）
 *   other        有职位但未命中关键词（低置信）
 *   unknown      无职位（或导入历史数据，由回填逐步补齐）
 *
 * 推断只基于职位文本（零网络、零 AI 成本），evidence 记录命中关键词；
 * 管理员可通过 PATCH /admin/api/crm/contacts/:id 显式覆盖
 * （procurement_role + role_evidence），显式值永不被自动推断改写，
 * 重改职位时才会重新推断。
 */

import type { AdminEnv } from "./admin";

export const PROCUREMENT_ROLES = [
  "owner",
  "procurement",
  "finance",
  "channel",
  "operations",
  "sales",
  "other",
  "unknown",
] as const;

export type ProcurementRole = (typeof PROCUREMENT_ROLES)[number];

export interface RoleInference {
  role: ProcurementRole;
  confidence: number;
  evidence: string;
}

/** 关键词按优先级排序：先具体职能、后泛化头衔，避免
 * "Director of Sales" 被 owner 的 "director" 类关键词抢先命中。 */
const ROLE_KEYWORDS: Array<{ role: ProcurementRole; keywords: string[] }> = [
  {
    role: "procurement",
    keywords: [
      "purchas", "procure", "procurement", "buyer", "buying office", "sourcing",
      "supply chain", "supplier", "采购", "采买", "供应链", "供应商",
    ],
  },
  {
    role: "finance",
    keywords: ["cfo", "finance", "financial", "accountant", "controller", "财务", "会计", "出纳"],
  },
  {
    role: "channel",
    keywords: [
      "channel", "partnership", "dealer", "dealership", "franchis", "distribut",
      "渠道", "经销", "加盟", "合作伙伴",
    ],
  },
  {
    role: "operations",
    keywords: [
      "operation", "ops ", "production", "manufactur", "logistic", "warehouse",
      "plant manager", "运营", "生产", "制造", "物流", "仓储", "厂长",
    ],
  },
  {
    role: "sales",
    keywords: [
      "sales", "business development", "b2b", "account manager", "account executive",
      "commercial", "export", "销售", "商务", "业务", "客户经理", "外贸",
    ],
  },
  {
    role: "owner",
    keywords: [
      "ceo", "c.e.o", "founder", "co-founder", "coowner", "co-owner", "owner",
      "president", "managing director", "general manager", "chairman", "chairperson",
      "proprietor", "principal", "partner", "chief", "总经理", "董事长", "执行董事",
      "创始人", "老板", "合伙人",
    ],
  },
];

/** 从职位文本推断采购角色。空/无职位 → unknown；有职位但未命中 → other。 */
export function inferProcurementRole(jobTitle: string | null | undefined): RoleInference {
  const title = (jobTitle ?? "").trim();
  if (!title) {
    return { role: "unknown", confidence: 0, evidence: "无职位信息，角色未知" };
  }
  const lower = title.toLowerCase();
  for (const group of ROLE_KEYWORDS) {
    for (const keyword of group.keywords) {
      if (lower.includes(keyword)) {
        return {
          role: group.role,
          confidence: 0.8,
          evidence: `职位"${title}"命中${roleLabel(group.role)}关键词: ${keyword}`,
        };
      }
    }
  }
  return {
    role: "other",
    confidence: 0.3,
    evidence: `职位"${title}"未命中已知角色关键词，请人工确认`,
  };
}

export function roleLabel(role: string): string {
  switch (role) {
    case "owner": return "老板/决策";
    case "procurement": return "采购";
    case "finance": return "财务";
    case "channel": return "渠道";
    case "operations": return "运营";
    case "sales": return "销售";
    case "other": return "其他";
    default: return "未识别";
  }
}

/** 回填历史联系人（0037 之前导入、procurement_role='unknown' 且有职位）：
 * 每批 50 条，由监测 tick 顺带执行，逐步收敛，不打断主流程。 */
export async function backfillUnknownRoles(env: AdminEnv): Promise<number> {
  const rows = await env.DB.prepare(
    "SELECT id, job_title FROM crm_contacts WHERE procurement_role = 'unknown' AND job_title IS NOT NULL AND TRIM(job_title) != '' LIMIT 50",
  ).all<{ id: string; job_title: string }>();
  let updated = 0;
  for (const row of rows.results) {
    const inference = inferProcurementRole(row.job_title);
    if (inference.role === "unknown") continue;
    await env.DB.prepare(
      "UPDATE crm_contacts SET procurement_role = ?2, role_evidence = ?3, role_updated_at = ?4 WHERE id = ?1",
    )
      .bind(row.id, inference.role, inference.evidence, new Date().toISOString())
      .run();
    updated++;
  }
  return updated;
}
