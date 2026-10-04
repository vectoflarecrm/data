// Security V2 Stage 2: role-based access control.
//
// The admin surface used to be all-or-nothing: knowing the master token meant
// root over every route. Roles give the single operator a way to hand out
// narrow credentials (e.g. a sender who may send mail but not touch provider
// keys) without sharing root.
//
// Enforcement is server-side only, in the central /admin/api/* gate of
// handleAdminRequest — hiding a button in the panel is never a control.

export type AdminRole =
  | "super_admin"
  | "operator"
  | "researcher"
  | "sender"
  | "readonly";

export type Permission =
  | "customers.read"
  | "customers.write"
  | "research.read"
  | "research.run"
  | "campaigns.read"
  | "campaigns.write"
  | "outreach.read"
  | "outreach.generate"
  | "outreach.send"
  | "providers.read"
  | "providers.write"
  | "credentials.read"
  | "credentials.write"
  | "audit.read";

const READ_PERMISSIONS: readonly Permission[] = [
  "customers.read",
  "research.read",
  "campaigns.read",
  "outreach.read",
  "providers.read",
  "credentials.read",
  "audit.read",
];

/** Role → granted permissions (the stage-2 matrix, verbatim). */
export const ROLE_PERMISSIONS: Record<AdminRole, ReadonlySet<Permission>> = {
  super_admin: new Set<Permission>([
    ...READ_PERMISSIONS,
    "customers.write",
    "research.run",
    "campaigns.write",
    "outreach.generate",
    "outreach.send",
    "providers.write",
    "credentials.write",
  ]),
  operator: new Set<Permission>([
    "customers.read",
    "customers.write",
    "research.read",
    "research.run",
    "campaigns.read",
    "campaigns.write",
    "outreach.read",
    "outreach.generate",
  ]),
  researcher: new Set<Permission>([
    "customers.read",
    "research.read",
    "research.run",
  ]),
  sender: new Set<Permission>([
    "customers.read",
    "outreach.read",
    "outreach.send",
  ]),
  readonly: new Set<Permission>([...READ_PERMISSIONS]),
};

export function isAdminRole(value: string): value is AdminRole {
  return value in ROLE_PERMISSIONS;
}

export function roleHasPermission(role: string, permission: Permission): boolean {
  return isAdminRole(role) && ROLE_PERMISSIONS[role].has(permission);
}

function segments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

/**
 * Route → required permission. Returns null when the path carries no
 * permission requirement (unknown /admin/api/* paths stay null and 404 in
 * the router, exactly as before).
 *
 * Method is part of the decision: the same path can be a read (GET) or a
 * mutation (POST/PATCH/DELETE).
 */
export function requiredPermission(url: URL, method: string): Permission | null {
  const path = url.pathname;
  if (!path.startsWith("/admin/api/")) return null;
  const parts = segments(path); // ["admin", "api", "keys", ...]

  // /admin/api/auth/* — session lifecycle, no business permission attached.
  if (parts[2] === "auth") return null;

  // ── Provider keys (/admin/api/keys…) ──
  if (parts[2] === "keys") {
    if (path === "/admin/api/keys/encrypt-all" || path === "/admin/api/keys/encryption-key") {
      return "credentials.write";
    }
    if (method === "GET") return "providers.read";
    return "providers.write";
  }

  // ── Cloudflare Worker secrets (/admin/api/secrets…) ──
  // Removed in Stage 3: the Worker no longer manages its own Cloudflare
  // secrets at all (docs/secret-management.md). The path now falls through to
  // the router's 404 — intentionally not mapped.

  // ── Gmail sender pool (/admin/api/gmail…) ──
  if (parts[2] === "gmail") {
    if (path === "/admin/api/gmail/encrypt-all") return "credentials.write";
    if (path === "/admin/api/gmail/accounts" && method === "GET") return "outreach.read";
    // Account test drives a real send through the account — sender territory.
    if (parts[3] === "accounts" && parts.length === 5 && parts[4] === "test" && method === "POST") {
      return "outreach.send";
    }
    return "credentials.write";
  }

  // ── Outreach (/admin/api/outreach…) ──
  if (parts[2] === "outreach") {
    // Campaign-owned subroutes (segment-preview / groups / campaigns).
    if (parts[3] === "segment-preview") return "campaigns.read";
    if (parts[3] === "groups") {
      return method === "GET" ? "campaigns.read" : "campaigns.write";
    }
    if (parts[3] === "campaigns") {
      // /campaigns, /campaigns/:id, /campaigns/:id/{members,generate,send,status}
      if (parts.length === 4) return method === "GET" ? "campaigns.read" : "campaigns.write";
      if (parts.length >= 5) {
        if (method === "GET") return "campaigns.read";
        // Stage 22 fix: the action lives at parts[5] ("/campaigns/:id/send"),
        // parts[4] is the numeric id — the old parts[4] check never matched,
        // so campaign send was gated as campaigns.write and the sender role
        // (outreach.send) was wrongly denied its designed capability.
        const action = parts.length >= 6 ? parts[5] : "";
        if (action === "send") return "outreach.send";
        return "campaigns.write"; // status changes, draft generation, deletes
      }
      return "campaigns.read";
    }
    // Direct outreach surface.
    if (parts[3] === "settings") {
      return method === "GET" ? "outreach.read" : "campaigns.write";
    }
    if (parts[3] === "attachments") {
      return method === "GET" ? "outreach.read" : "campaigns.write";
    }
    if (parts[3] === "generate" && method === "POST") return "outreach.generate";
    if (parts[3] === "send-batch" && method === "POST") return "outreach.send";
    if (parts[3] === "emails") {
      if (parts.length === 4) return "outreach.read"; // list
      if (parts.length === 5) {
        if (method === "PATCH" || method === "DELETE") return "outreach.generate";
        if (parts[4] === "send" && method === "POST") return "outreach.send";
        return "outreach.read";
      }
      return "outreach.read";
    }
    if (["stats", "quota"].includes(parts[3] ?? "") && method === "GET") return "outreach.read";
    return "outreach.read";
  }

  // ── Customers (/admin/api/customers…) ──
  if (parts[2] === "customers") {
    if (parts[3] === "import" && method === "POST") return "customers.write";
    // pre-filter with action=queue re-queues rows for research (a mutation).
    if (parts[3] === "pre-filter" && method === "GET") {
      return url.searchParams.get("action") === "queue" ? "research.run" : "customers.read";
    }
    if (method === "GET") return "customers.read";
    return "customers.write";
  }

  return null;
}
