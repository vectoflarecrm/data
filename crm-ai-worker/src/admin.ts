export interface AdminEnv {
  DB: D1Database;
  ADMIN_PANEL_TOKEN?: string;
}

interface AdminCustomer {
  id: number;
  company_id: string;
  domain: string;
  status: string;
  customer_segment: string | null;
  personas_and_solutions: string | null;
  remarks: string | null;
  updated_at: string;
}

const CUSTOMER_COLUMNS = `
  id, company_id, domain, status, customer_segment,
  personas_and_solutions, remarks, updated_at
`;
const CUSTOMER_STATUSES = new Set(["pending", "processing", "completed", "failed"]);
const COOKIE_NAME = "crm_admin_token";
const SESSION_MAX_AGE = 60 * 60;

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function readCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get("Cookie")?.split(";") ?? [];
  for (const cookie of cookies) {
    const [key, ...value] = cookie.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

async function constantTimeSecretMatch(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

async function isAuthenticated(request: Request, env: AdminEnv): Promise<boolean> {
  if (!env.ADMIN_PANEL_TOKEN) return false;
  const authorization = request.headers.get("Authorization");
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : null;
  const candidate = bearer || readCookie(request, COOKIE_NAME);
  return candidate ? constantTimeSecretMatch(candidate, env.ADMIN_PANEL_TOKEN) : false;
}

function authFailure(request: Request): Response {
  if (new URL(request.url).pathname.startsWith("/admin/api/")) {
    return jsonResponse({ detail: "Admin authentication required" }, 401);
  }
  return htmlResponse(ADMIN_LOGIN_HTML, 401);
}

function validateText(value: unknown, field: string, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  if (value.length > maxLength) throw new Error(`${field} is too long`);
  return value.trim();
}

function validateDomain(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("domain is required");
  const candidate = value.trim();
  const url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("domain must use HTTP or HTTPS");
  }
  return url.toString();
}

function normalizePersonaJson(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("personas_and_solutions must be valid JSON");
    }
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("personas_and_solutions must be a JSON object or array");
  }
  const serialized = JSON.stringify(parsed);
  if (serialized.length > 30_000) throw new Error("personas_and_solutions is too long");
  return serialized;
}

function parseCustomerId(pathname: string): number | null {
  const match = pathname.match(/^\/admin\/api\/customers\/(\d+)$/);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function getCustomer(env: AdminEnv, id: number): Promise<AdminCustomer | null> {
  const result = await env.DB.prepare(
    `SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE id = ? LIMIT 1`,
  )
    .bind(id)
    .first<AdminCustomer>();
  return result ?? null;
}

async function listCustomers(request: Request, env: AdminEnv): Promise<Response> {
  const url = new URL(request.url);
  const search = (url.searchParams.get("q") ?? "").trim();
  const status = (url.searchParams.get("status") ?? "").trim();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 100);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
  const where: string[] = [];
  const bindings: Array<string | number> = [];

  if (search) {
    where.push("(company_id LIKE ? OR domain LIKE ? OR customer_segment LIKE ? OR remarks LIKE ?)");
    const pattern = `%${search}%`;
    bindings.push(pattern, pattern, pattern, pattern);
  }
  if (status) {
    if (!CUSTOMER_STATUSES.has(status)) return jsonResponse({ detail: "Invalid status" }, 400);
    where.push("status = ?");
    bindings.push(status);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows, count] = await Promise.all([
    env.DB.prepare(
      `SELECT ${CUSTOMER_COLUMNS} FROM customers ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
      .bind(...bindings, limit, offset)
      .all<AdminCustomer>(),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM customers ${clause}`)
      .bind(...bindings)
      .first<{ total: number }>(),
  ]);
  return jsonResponse({
    items: rows.results,
    total: count?.total ?? 0,
    limit,
    offset,
  });
}

async function updateCustomer(request: Request, env: AdminEnv, id: number): Promise<Response> {
  const existing = await getCustomer(env, id);
  if (!existing) return jsonResponse({ detail: "Customer not found" }, 404);

  let payload: Record<string, unknown>;
  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return jsonResponse({ detail: "JSON object required" }, 400);
    }
    payload = body as Record<string, unknown>;
  } catch {
    return jsonResponse({ detail: "Invalid JSON body" }, 400);
  }

  try {
    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    if ("domain" in payload) {
      assignments.push("domain = ?");
      values.push(validateDomain(payload.domain));
    }
    if ("status" in payload) {
      if (typeof payload.status !== "string" || !CUSTOMER_STATUSES.has(payload.status)) {
        return jsonResponse({ detail: "Invalid status" }, 400);
      }
      assignments.push("status = ?");
      values.push(payload.status);
    }
    if ("customer_segment" in payload) {
      assignments.push("customer_segment = ?");
      values.push(validateText(payload.customer_segment, "customer_segment", 200));
    }
    if ("personas_and_solutions" in payload) {
      assignments.push("personas_and_solutions = ?");
      values.push(normalizePersonaJson(payload.personas_and_solutions));
    }
    if ("remarks" in payload) {
      assignments.push("remarks = ?");
      values.push(validateText(payload.remarks, "remarks", 10_000));
    }
    if (!assignments.length) return jsonResponse({ detail: "No editable fields supplied" }, 400);

    const updated = await env.DB.prepare(
      `UPDATE customers SET ${assignments.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING ${CUSTOMER_COLUMNS}`,
    )
      .bind(...values, id)
      .first<AdminCustomer>();
    return jsonResponse(updated ?? { detail: "Customer not found" }, updated ? 200 : 404);
  } catch (error) {
    return jsonResponse(
      { detail: error instanceof Error ? error.message : "Invalid customer data" },
      400,
    );
  }
}

async function handleAdminApi(request: Request, env: AdminEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/admin/api/customers" && request.method === "GET") {
    return listCustomers(request, env);
  }
  const id = parseCustomerId(url.pathname);
  if (id !== null) {
    if (request.method === "GET") {
      const customer = await getCustomer(env, id);
      return customer ? jsonResponse(customer) : jsonResponse({ detail: "Customer not found" }, 404);
    }
    if (request.method === "PATCH") return updateCustomer(request, env, id);
  }
  return jsonResponse({ detail: "Not Found" }, 404);
}

export async function handleAdminRequest(
  request: Request,
  env: AdminEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/admin" && !url.pathname.startsWith("/admin/")) return null;

  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    if (request.method !== "GET") return jsonResponse({ detail: "Method Not Allowed" }, 405);
    return (await isAuthenticated(request, env))
      ? htmlResponse(ADMIN_PANEL_HTML)
      : htmlResponse(ADMIN_LOGIN_HTML);
  }

  if (url.pathname === "/admin/login" && request.method === "POST") {
    if (!env.ADMIN_PANEL_TOKEN) {
      return htmlResponse("<h1>Admin panel is not configured</h1><p>Set ADMIN_PANEL_TOKEN first.</p>", 503);
    }
    const form = await request.formData();
    const token = form.get("token");
    if (typeof token !== "string" || !(await constantTimeSecretMatch(token, env.ADMIN_PANEL_TOKEN))) {
      return htmlResponse(`${ADMIN_LOGIN_HTML}<p class="error">授权失败，请重试。</p>`, 401);
    }
    return new Response(null, {
      status: 303,
      headers: {
        Location: new URL("/admin", request.url).toString(),
        "Set-Cookie": `${COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${SESSION_MAX_AGE}; Path=/admin; HttpOnly;${new URL(request.url).protocol === "https:" ? " Secure;" : ""} SameSite=Strict`,
        "Cache-Control": "no-store",
      },
    });
  }

  if (url.pathname === "/admin/logout" && request.method === "POST") {
    return new Response(null, {
      status: 303,
      headers: {
        Location: new URL("/admin", request.url).toString(),
        "Set-Cookie": `${COOKIE_NAME}=; Max-Age=0; Path=/admin; HttpOnly;${new URL(request.url).protocol === "https:" ? " Secure;" : ""} SameSite=Strict`,
      },
    });
  }

  if (url.pathname.startsWith("/admin/api/")) {
    if (!(await isAuthenticated(request, env))) return authFailure(request);
    return handleAdminApi(request, env);
  }

  return new Response("Not Found", { status: 404 });
}

const ADMIN_LOGIN_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>D1 CRM 管理登录</title><style>body{font-family:system-ui,sans-serif;background:#eef4fa;display:grid;place-items:center;min-height:100vh;margin:0}.card{background:#fff;padding:28px;border-radius:14px;box-shadow:0 8px 30px #123b6820;width:min(420px,calc(100% - 40px))}h1{margin-top:0;color:#123b68}label{display:block;font-weight:600;margin:16px 0 6px}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:8px;font:inherit}button{margin-top:18px;background:#1677d2;color:#fff;border:0;border-radius:8px;padding:12px 18px;cursor:pointer;font:inherit}.error{color:#b91c1c}</style></head>
<body><main class="card"><h1>D1 CRM 管理面板</h1><p>请输入 ADMIN_PANEL_TOKEN 登录。</p><form method="post" action="/admin/login"><label for="token">管理 Token</label><input id="token" name="token" type="password" autocomplete="current-password" required><button type="submit">登录</button></form></main></body></html>`;

const ADMIN_PANEL_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>D1 CRM 客户管理</title><style>
:root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f4f7fb}*{box-sizing:border-box}body{margin:0}.top{background:#123b68;color:#fff;padding:18px 26px;display:flex;justify-content:space-between;gap:12px;align-items:center}.top h1{font-size:22px;margin:0}.wrap{max-width:1400px;margin:22px auto;padding:0 18px}.panel{background:#fff;border:1px solid #dce5f0;border-radius:12px;padding:18px;margin-bottom:18px}.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.toolbar input,.toolbar select,.editor input,.editor select,.editor textarea{font:inherit;padding:10px;border:1px solid #cbd5e1;border-radius:8px}.toolbar input{min-width:240px}.button{background:#1677d2;color:#fff;border:0;border-radius:8px;padding:10px 15px;cursor:pointer;font:inherit}.button.secondary{background:#475569}.button.danger{background:#b91c1c}table{width:100%;border-collapse:collapse;margin-top:14px}th,td{text-align:left;padding:10px;border-bottom:1px solid #e2e8f0;vertical-align:top;font-size:14px}th{background:#f8fafc;white-space:nowrap}td{max-width:300px;overflow-wrap:anywhere}.badge{display:inline-block;border-radius:999px;padding:3px 9px;background:#e2e8f0;font-size:12px}.editor{display:grid;grid-template-columns:160px minmax(0,1fr);gap:12px;align-items:start}.editor label{font-weight:600;padding-top:10px}.editor textarea{min-height:90px;resize:vertical;width:100%}.editor input,.editor select{width:100%}.editor-actions{grid-column:2;display:flex;gap:10px}.notice{margin-top:12px;padding:10px;border-radius:8px;background:#eff6ff}.success{background:#ecfdf5;color:#065f46}.error{background:#fef2f2;color:#991b1b}.hidden{display:none}.pager{display:flex;justify-content:space-between;align-items:center;margin-top:14px;gap:12px}@media(max-width:700px){.editor{grid-template-columns:1fr}.editor-actions{grid-column:1}.top{align-items:flex-start;flex-direction:column}table{display:block;overflow-x:auto;white-space:nowrap}}
</style></head><body><header class="top"><h1>D1 CRM 客户管理面板</h1><form method="post" action="/admin/logout"><button class="button secondary" type="submit">退出登录</button></form></header><main class="wrap">
<section class="panel"><h2>客户列表</h2><div class="toolbar"><input id="search" placeholder="公司 ID、网址、细分或备注"><select id="status"><option value="">全部状态</option><option value="pending">pending</option><option value="processing">processing</option><option value="completed">completed</option><option value="failed">failed</option></select><button class="button" id="load">刷新</button><span id="summary"></span></div><div id="listMessage"></div><table><thead><tr><th>ID</th><th>公司 ID</th><th>网址</th><th>状态</th><th>客户细分</th><th>备注</th><th>更新时间</th><th>操作</th></tr></thead><tbody id="rows"></tbody></table><div class="pager"><button class="button secondary" id="prev">上一页</button><span id="pageInfo"></span><button class="button secondary" id="next">下一页</button></div></section>
<section class="panel hidden" id="editPanel"><h2>编辑客户</h2><div class="editor"><label>ID</label><input id="editId" readonly><label>公司 ID</label><input id="editCompanyId" readonly><label>网址</label><input id="editDomain" required><label>状态</label><select id="editStatus"><option value="pending">pending</option><option value="processing">processing</option><option value="completed">completed</option><option value="failed">failed</option></select><label>客户细分</label><input id="editSegment"><label>画像与解决方案 JSON</label><textarea id="editPersonas" placeholder='{"personas":[],"solutions":[]}'></textarea><label>中文备注</label><textarea id="editRemarks"></textarea><div class="editor-actions"><button class="button" id="save">保存修改</button><button class="button secondary" id="cancel">取消</button><button class="button secondary" id="requeue">设为 pending 重新处理</button></div><div id="editMessage" class="notice hidden"></div></div></section>
</main><script>
(function(){
  var state={offset:0,limit:50,total:0,selected:null};
  var $=function(id){return document.getElementById(id)};
  var esc=function(value){return String(value==null?'':value).replace(/[&<>"']/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]})};
  var api=function(path,options){return fetch(path,options||{}).then(function(response){if(response.status===401){location='/admin';throw new Error('登录已过期')}return response.json().then(function(data){if(!response.ok)throw new Error(data.detail||'请求失败');return data})})};
  var showMessage=function(id,text,good){var el=$(id);el.textContent=text;el.className='notice '+(good?'success':'error');el.classList.remove('hidden')};
  var load=function(){var params=new URLSearchParams({q:$('search').value,status:$('status').value,limit:String(state.limit),offset:String(state.offset)});api('/admin/api/customers?'+params.toString()).then(function(data){state.total=data.total; $('summary').textContent='共 '+data.total+' 条'; $('rows').innerHTML=data.items.map(function(c){return '<tr><td>'+esc(c.id)+'</td><td>'+esc(c.company_id)+'</td><td>'+esc(c.domain)+'</td><td><span class="badge">'+esc(c.status)+'</span></td><td>'+esc(c.customer_segment||'-')+'</td><td>'+esc(c.remarks||'-')+'</td><td>'+esc(c.updated_at||'-')+'</td><td><button class="button" onclick="window.editCustomer('+c.id+')">查看/修改</button></td></tr>'}).join('')||'<tr><td colspan="8">暂无数据</td></tr>'; $('pageInfo').textContent=(state.total?state.offset+1:0)+'-'+Math.min(state.offset+state.limit,state.total)+' / '+state.total; $('prev').disabled=state.offset===0; $('next').disabled=state.offset+state.limit>=state.total}).catch(function(error){showMessage('listMessage',error.message,false)})};
  window.editCustomer=function(id){api('/admin/api/customers/'+id).then(function(c){state.selected=id;$('editPanel').classList.remove('hidden');$('editId').value=c.id;$('editCompanyId').value=c.company_id;$('editDomain').value=c.domain||'';$('editStatus').value=c.status;$('editSegment').value=c.customer_segment||'';$('editPersonas').value=c.personas_and_solutions||'';$('editRemarks').value=c.remarks||'';window.scrollTo({top:document.body.scrollHeight,behavior:'smooth'})}).catch(function(error){showMessage('listMessage',error.message,false)})};
  $('load').onclick=function(){state.offset=0;load()};$('search').onkeydown=function(event){if(event.key==='Enter'){state.offset=0;load()}};$('status').onchange=function(){state.offset=0;load()};$('prev').onclick=function(){if(state.offset>0){state.offset=Math.max(0,state.offset-state.limit);load()}};$('next').onclick=function(){if(state.offset+state.limit<state.total){state.offset+=state.limit;load()}};$('cancel').onclick=function(){$('editPanel').classList.add('hidden')};
  $('save').onclick=function(){if(state.selected===null)return;var payload={domain:$('editDomain').value,status:$('editStatus').value,customer_segment:$('editSegment').value,personas_and_solutions:$('editPersonas').value,remarks:$('editRemarks').value};api('/admin/api/customers/'+state.selected,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}).then(function(){showMessage('editMessage','保存成功',true);load()}).catch(function(error){showMessage('editMessage',error.message,false)})};
  $('requeue').onclick=function(){if(state.selected===null)return;$('editStatus').value='pending';$('save').click()};load();
})();
</script></body></html>`;
