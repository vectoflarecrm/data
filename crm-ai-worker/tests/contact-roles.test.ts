import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AdminEnv } from "../src/admin";
import {
  backfillUnknownRoles,
  inferProcurementRole,
  roleLabel,
} from "../src/contact-roles";

/* ⑦ 多角色采购联系人图谱（更新.txt 第 7 项）：职位关键词 → 采购角色推断，
 * 中英文头衔、优先级（职能词先于泛化头衔）、证据记录、历史回填。 */

class FakeD1 {
  constructor(private db: any) {}

  prepare(sql: string) {
    const db = this.db;
    let bound: unknown[] = [];
    return {
      bind(...args: unknown[]) {
        bound = args;
        return this;
      },
      async all<T>() {
        return { results: db.prepare(sql).all(...bound) as T[], success: true };
      },
      async first<T>() {
        return (db.prepare(sql).get(...bound) ?? undefined) as T | undefined;
      },
      async run() {
        const info = db.prepare(sql).run(...bound);
        return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
      },
    };
  }

  async batch(stmts: any[]) {
    for (const s of stmts) await s.run();
    return [];
  }
}

describe("inferProcurementRole 职位角色推断", () => {
  it("英文头衔映射到六类角色", () => {
    expect(inferProcurementRole("Chief Executive Officer").role).toBe("owner");
    expect(inferProcurementRole("Founder & CEO").role).toBe("owner");
    expect(inferProcurementRole("Managing Director").role).toBe("owner");
    expect(inferProcurementRole("Purchasing Manager").role).toBe("procurement");
    expect(inferProcurementRole("Head of Sourcing").role).toBe("procurement");
    expect(inferProcurementRole("CFO").role).toBe("finance");
    expect(inferProcurementRole("Channel Partner Manager").role).toBe("channel");
    expect(inferProcurementRole("Operations Director").role).toBe("operations");
    expect(inferProcurementRole("Sales Director").role).toBe("sales");
    expect(inferProcurementRole("Business Development Manager").role).toBe("sales");
  });

  it("中文头衔映射到六类角色", () => {
    expect(inferProcurementRole("总经理").role).toBe("owner");
    expect(inferProcurementRole("创始人").role).toBe("owner");
    expect(inferProcurementRole("采购经理").role).toBe("procurement");
    expect(inferProcurementRole("供应链总监").role).toBe("procurement");
    expect(inferProcurementRole("财务总监").role).toBe("finance");
    expect(inferProcurementRole("渠道经理").role).toBe("channel");
    expect(inferProcurementRole("运营经理").role).toBe("operations");
    expect(inferProcurementRole("销售总监").role).toBe("sales");
  });

  it("职能词优先于泛化头衔：Director of Sales 归销售、Supply Chain Head 归采购", () => {
    // "director" 不是 owner 关键词；"sales" 命中在前 → sales。
    expect(inferProcurementRole("Director of Sales").role).toBe("sales");
    // "head"/"director" 泛化，但 "supply chain" 采购词优先 → procurement。
    expect(inferProcurementRole("Supply Chain Head").role).toBe("procurement");
  });

  it("空职位 → unknown；有职位未命中 → other（低置信）", () => {
    expect(inferProcurementRole(null)).toMatchObject({ role: "unknown", confidence: 0 });
    expect(inferProcurementRole("  ")).toMatchObject({ role: "unknown" });
    const other = inferProcurementRole("Nit Diver");
    expect(other.role).toBe("other");
    expect(other.confidence).toBeLessThan(0.5);
    expect(other.evidence).toContain("Nit Diver");
  });

  it("命中时记录证据（职位 + 命中关键词）", () => {
    const r = inferProcurementRole("Purchasing Manager");
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
    expect(r.evidence).toContain("Purchasing Manager");
    expect(r.evidence).toContain("purchas");
  });

  it("roleLabel 中文标签", () => {
    expect(roleLabel("owner")).toBe("老板/决策");
    expect(roleLabel("procurement")).toBe("采购");
    expect(roleLabel("unknown")).toBe("未识别");
  });
});

describe("backfillUnknownRoles 历史角色回填", () => {
  function makeDb() {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE crm_companies (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE crm_contacts (
        id TEXT PRIMARY KEY, company_id TEXT NOT NULL, full_name TEXT NOT NULL,
        job_title TEXT, procurement_role TEXT NOT NULL DEFAULT 'unknown',
        role_evidence TEXT, role_updated_at TEXT
      );
    `);
    return db;
  }

  it("回填有职位的 unknown 联系人，跳过无职位与已识别的", async () => {
    const db = makeDb();
    const ins = db.prepare("INSERT INTO crm_contacts (id, company_id, full_name, job_title, procurement_role) VALUES (?, 'c1', ?, ?, ?)");
    ins.run("ct1", "张三", "采购经理", "unknown");
    ins.run("ct2", "李四", null, "unknown"); // 无职位 → 保持 unknown
    ins.run("ct3", "王五", "Sales Manager", "sales"); // 已识别 → 不动
    ins.run("ct4", "赵六", "总经理", "unknown");

    const updated = await backfillUnknownRoles({ DB: new FakeD1(db) } as unknown as AdminEnv);
    expect(updated).toBe(2);
    expect(db.prepare("SELECT procurement_role FROM crm_contacts WHERE id = 'ct1'").get())
      .toMatchObject({ procurement_role: "procurement" });
    expect(db.prepare("SELECT procurement_role FROM crm_contacts WHERE id = 'ct2'").get())
      .toMatchObject({ procurement_role: "unknown" });
    expect(db.prepare("SELECT role_evidence FROM crm_contacts WHERE id = 'ct3'").get())
      .toMatchObject({ role_evidence: null });
    expect(db.prepare("SELECT procurement_role, role_updated_at FROM crm_contacts WHERE id = 'ct4'").get())
      .toMatchObject({ procurement_role: "owner" });
    expect(db.prepare("SELECT role_updated_at FROM crm_contacts WHERE id = 'ct4'").get().role_updated_at).toBeTruthy();
  });
});
