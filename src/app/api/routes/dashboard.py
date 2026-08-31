from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

router = APIRouter(tags=["dashboard"])


@router.get("/dashboard", response_class=HTMLResponse, include_in_schema=False)
async def dashboard() -> HTMLResponse:
    return HTMLResponse(_PAGE)


_PAGE = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Watersports Database Dashboard</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;background:#f4f7fb;color:#172033}.top{background:#123b68;color:white;padding:20px 28px}.wrap{max-width:1200px;margin:24px auto;padding:0 18px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.card,.panel{background:white;border:1px solid #dce5f0;border-radius:12px;padding:16px;margin-bottom:16px}.metric{font-size:28px;font-weight:700}.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.toolbar input,.toolbar select,.toolbar textarea{padding:10px;border:1px solid #cbd5e1;border-radius:8px}.button{background:#1677d2;color:#fff;border:0;border-radius:8px;padding:10px 15px;cursor:pointer}.secondary{background:#475569}.company-editor{margin-top:14px;padding:14px;background:#f8fafc;border:1px solid #dce5f0;border-radius:10px}.edit-row{display:grid;grid-template-columns:150px minmax(0,1fr);gap:12px;align-items:center;margin-bottom:10px}.edit-row label{font-weight:600}.edit-row input,.edit-row textarea{width:100%;font:inherit;padding:10px;border:1px solid #cbd5e1;border-radius:8px;resize:vertical}.edit-actions{display:flex;justify-content:flex-end;margin-top:14px}@media(max-width:600px){.edit-row{grid-template-columns:1fr;gap:4px}}.tabs{display:flex;gap:8px;margin:20px 0;flex-wrap:wrap}.tab{padding:9px 14px;border:1px solid #cbd5e1;background:white;border-radius:8px;cursor:pointer}.tab.active{background:#123b68;color:white}.hidden{display:none}table{width:100%;border-collapse:collapse;margin-top:14px}th,td{text-align:left;padding:10px;border-bottom:1px solid #e2e8f0;font-size:14px}th{background:#f8fafc}.notice{margin-top:12px;padding:10px;border-radius:8px;background:#eff6ff}.danger{background:#fef2f2;color:#991b1b}.success{background:#ecfdf5;color:#065f46}details{margin:8px 0}@media(max-width:800px){.grid{grid-template-columns:repeat(2,1fr)}}
</style></head><body>
<header class="top"><h1>Global Watersports B2B Intelligence Database</h1><div>客户数据库控制面板</div></header><main class="wrap">
<section class="grid"><div class="card">公司总数<div id="companies" class="metric">-</div></div><div class="card">联系人<div id="contacts" class="metric">-</div></div><div class="card">邮箱<div id="emails" class="metric">-</div></div><div class="card">待研究任务<div id="tasks" class="metric">-</div></div></section>
<nav class="tabs"><button class="tab active" data-target="customers">客户浏览</button><button class="tab" data-target="research">研究任务</button><button class="tab" data-target="imports">导入数据</button><button class="tab" data-target="suppression">错误邮箱</button><button class="tab" data-target="outreach">Outreach</button><button class="tab" data-target="database">数据库结构</button></nav>
<section id="customers" class="panel"><h2>客户列表</h2><div id="companyLoadError"></div><div class="toolbar"><input id="q" placeholder="公司名或域名"><input id="country" placeholder="国家代码"><select id="product"><option value="">产品分类</option><option value="RIB_BOAT">RIB boats</option><option value="INFLATABLE_BOAT">Inflatable boats</option><option value="SUP">SUPs (standup paddleboards)</option></select><button id="searchCompanies" class="button">搜索</button></div><table><thead><tr><th>公司</th><th>国家</th><th>网站</th><th>产品</th><th>研究状态</th><th>Lead Score</th></tr></thead><tbody id="companyRows"></tbody></table><div class="toolbar"><button id="previousCompanies" class="button secondary">上一页</button><span id="companyPageInfo"></span><button id="nextCompanies" class="button secondary">下一页</button><select id="companyPageSize"><option value="50">每页50</option><option value="100">每页100</option><option value="200">每页200</option></select></div><div id="companyDetail" class="hidden"></div></section>
<section id="research" class="panel hidden"><h2>研究任务</h2><div class="toolbar"><input id="researchCompany" placeholder="公司 ID"><select id="researchType"><option value="FULL_ENRICHMENT">完整补全</option><option value="COMPANY_RESEARCH">公司研究</option><option value="CONTACT_DISCOVERY">联系人发现</option><option value="SOCIAL_DISCOVERY">社交发现</option><option value="LEAD_SCORING">Lead Score</option></select><button id="enqueueResearch" class="button">创建任务</button><button id="runResearch" class="button secondary">执行任务</button></div><div id="researchResult"></div><table><tbody id="researchRows"></tbody></table></section>
<section id="imports" class="panel hidden"><h2>导入数据</h2><form id="customerForm"><input type="file" accept=".csv" required><button class="button">导入客户 CSV</button></form><div id="customerResult"></div><form id="suppressionForm"><input type="file" accept=".csv" required><button class="button secondary">导入错误邮箱 CSV</button></form><div id="suppressionResult"></div></section>
<section id="suppression" class="panel hidden"><h2>错误邮箱检查</h2><div class="toolbar"><input id="email" type="email"><button id="checkEmail" class="button">检查邮箱</button></div><div id="emailResult"></div></section>
<section id="outreach" class="panel hidden"><h2>Outreach 管理</h2><button id="loadOutreach" class="button">刷新邮件记录</button><table><tbody id="outreachRows"></tbody></table></section>
<section id="database" class="panel hidden"><h2>数据库结构</h2><button id="loadSchema" class="button">刷新数据库结构</button><div id="schemaResult"></div></section></main>
<script src="/static/dashboard.js?v=2"></script></body></html>"""
