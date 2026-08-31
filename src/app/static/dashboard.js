(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = { page: 1, pages: 1 };
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
  const notice = (id, text, good = false) => {
    const target = $(id);
    if (target) target.innerHTML = `<div class="notice ${good ? 'success' : 'danger'}">${escapeHtml(text)}</div>`;
  };
  async function json(url, options) {
    const response = await fetch(url, options);
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`服务器返回无效响应 (${response.status})`); }
    if (!response.ok) throw new Error(data.detail || `请求失败 (${response.status})`);
    return data;
  }
  async function loadStats() {
    try {
      const data = await json('/stats');
      $('companies').textContent = data.companies_total;
      $('contacts').textContent = data.contacts_total;
      $('emails').textContent = data.emails_found;
      $('tasks').textContent = data.research_tasks_pending;
    } catch (error) { notice('companyLoadError', error.message); }
  }
  async function loadCompanies(page = 1) {
    try {
      state.page = page;
      const params = new URLSearchParams({ page: String(page), page_size: $('companyPageSize').value });
      if ($('q').value) params.set('q', $('q').value);
      if ($('country').value) params.set('country_code', $('country').value);
      if ($('product').value) params.set('product_category', $('product').value);
      const data = await json(`/companies?${params}`);
      state.pages = data.pages;
      $('companyPageInfo').textContent = `第 ${data.page} / ${data.pages} 页，共 ${data.total} 家公司`;
      const rows = (data.items || []).map((company) => {
        const row = document.createElement('tr');
        [company.company_name, company.country || '-', company.website || '-', company.main_products_summary || '-', company.research_status, company.lead_score ?? '-'].forEach((value, index) => {
          const cell = document.createElement('td');
          if (index === 0) { const button = document.createElement('button'); button.className = 'button'; button.textContent = value; button.onclick = () => showCompany(company.id); cell.appendChild(button); }
          else cell.textContent = value;
          row.appendChild(cell);
        });
        return row;
      });
      $('companyRows').replaceChildren(...rows);
      if (!rows.length) $('companyRows').innerHTML = '<tr><td colspan="6">暂无数据</td></tr>';
    } catch (error) { $('companyRows').innerHTML = `<tr><td colspan="6" class="danger">客户数据加载失败：${escapeHtml(error.message)}</td></tr>`; }
  }
  async function showCompany(id) {
    try {
      const company = await json(`/companies/${id}`);
      const detail = $('companyDetail'); detail.classList.remove('hidden');
      detail.innerHTML = `<h3>${escapeHtml(company.company_name)}</h3><button id="editCompany" class="button secondary">修改公司信息</button><button id="loadRelated" class="button">查看全部关联数据</button><button id="rebuildContext" class="button secondary">重建 AI Context</button><div id="companyEditor" class="hidden"></div><p>${escapeHtml(company.description || '暂无描述')}</p><div id="relatedData"></div>`;
      $('loadRelated').onclick = () => loadRelated(id);
      $('rebuildContext').onclick = () => rebuildContext(id);
      $('editCompany').onclick = () => renderCompanyEditor(id, company);
    } catch (error) { notice('companyLoadError', error.message); }
  }
  function renderCompanyEditor(id, company) {
    const editor = $('companyEditor'); editor.classList.remove('hidden'); editor.className = 'company-editor';
    const fields = [['company_name','公司名称'],['legal_name','法定名称'],['trading_name','贸易名称'],['website','网站'],['country','国家'],['country_code','国家代码'],['region','地区'],['city','城市'],['address','地址'],['postal_code','邮编'],['industry','行业'],['business_model','商业模式'],['founded_year','成立年份'],['employee_range','员工规模'],['description','公司描述'],['main_products_summary','主要产品摘要']];
    editor.innerHTML = fields.map(([key,label]) => `<div class="edit-row"><label for="edit_${key}">${label}</label>${['description','main_products_summary','address'].includes(key) ? `<textarea id="edit_${key}" rows="3">${escapeHtml(company[key] ?? '')}</textarea>` : `<input id="edit_${key}" value="${escapeHtml(company[key] ?? '')}">`}</div>`).join('') + `<div class="edit-row"><label for="edit_target_markets">目标市场</label><input id="edit_target_markets" value="${escapeHtml((company.target_markets || []).join(', '))}"></div><div class="edit-actions"><button id="saveCompany" class="button">保存修改</button></div><div id="companyEditResult"></div>`;
    $('saveCompany').onclick = async () => { const payload = {}; fields.forEach(([key]) => { const value = $(`edit_${key}`).value; payload[key] = key === 'founded_year' ? (value ? Number(value) : null) : (value || null); }); payload.target_markets = $('edit_target_markets').value.split(',').map(x => x.trim()).filter(Boolean); try { await json(`/companies/${id}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)}); notice('companyEditResult','公司信息已保存',true); await loadCompanies(state.page); await showCompany(id); } catch (error) { notice('companyEditResult',error.message); } };
  }
  async function loadRelated(id) {
    try {
      const [contacts, products, brands, social, evidence, score, context, tasks] = await Promise.all([
        json(`/companies/${id}/contacts`), json(`/companies/${id}/products`), json(`/companies/${id}/brands`), json(`/companies/${id}/social`), json(`/companies/${id}/evidence`), json(`/companies/${id}/score`), json(`/companies/${id}/context`), json(`/research/tasks?company_id=${id}`)
      ]);
      $('relatedData').innerHTML = `<div class="grid"><div class="card">联系人：${contacts.total}<br>产品：${products.total}<br>品牌：${brands.total}<br>社交账号：${social.total}<br>证据：${evidence.total}<br>Lead Score：${escapeHtml(score?.total_score ?? '暂无')}</div><div class="card"><strong>研究任务</strong><ul>${tasks.items.map(t => `<li>${escapeHtml(t.task_type)} · ${escapeHtml(t.status)}</li>`).join('') || '<li>暂无任务</li>'}</ul></div></div><h4>联系人</h4><ul>${contacts.items.map(c => `<li>${escapeHtml(c.full_name)} · ${escapeHtml(c.job_title || '')}</li>`).join('') || '<li>暂无联系人</li>'}</ul><h4>证据</h4><ul>${evidence.items.slice(0, 20).map(e => `<li>${escapeHtml(e.field_name)}：${escapeHtml(e.value)} · ${escapeHtml(e.confidence)} ${e.source_url ? `<a href="${escapeHtml(e.source_url)}" target="_blank">来源</a>` : ''}</li>`).join('') || '<li>暂无证据</li>'}</ul><h4>AI Context</h4>${context.map(c => `<details><summary>${escapeHtml(c.context_type)}</summary><p>${escapeHtml(c.content)}</p></details>`).join('') || '暂无 Context'}`;
    } catch (error) { notice('relatedData', error.message); }
  }
  async function rebuildContext(id) { try { await json(`/companies/${id}/context/rebuild`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ ai: false }) }); await loadRelated(id); } catch (error) { notice('relatedData', error.message); } }
  async function loadResearch() { try { const data = await json('/research/tasks?page_size=50'); $('researchRows').innerHTML = data.items.map(t => `<tr><td>${escapeHtml(t.task_type)}</td><td>${escapeHtml(t.company_id)}</td><td>${escapeHtml(t.status)}</td><td>${escapeHtml(t.priority)}</td></tr>`).join('') || '<tr><td colspan="4">暂无任务</td></tr>'; } catch (error) { notice('researchResult', error.message); } }
  async function loadOutreach() { try { const data = await json('/outreach'); $('outreachRows').innerHTML = data.map(o => `<tr><td>${escapeHtml(o.created_at)}</td><td>${escapeHtml(o.recipient_email || '-')}</td><td>${escapeHtml(o.subject || '-')}</td><td>${escapeHtml(o.status)}</td><td>${escapeHtml(o.suppression_status || '未检查')}</td></tr>`).join('') || '<tr><td colspan="5">暂无记录</td></tr>'; } catch (error) { notice('outreachResult', error.message); } }
  async function loadSchema() { try { const data = await json('/database/schema'); $('schemaResult').innerHTML = data.map(t => `<details><summary>${escapeHtml(t.table)} (${t.columns.length} 个字段)</summary><ul>${t.columns.map(c => `<li>${escapeHtml(c.name)} · ${escapeHtml(c.type)} · nullable=${escapeHtml(c.nullable)}</li>`).join('')}</ul></details>`).join(''); } catch (error) { notice('schemaResult', error.message); } }
  async function upload(form, url, result) { form.addEventListener('submit', async (event) => { event.preventDefault(); try { const body = new FormData(); body.append('file', form.querySelector('input').files[0]); await json(url, { method: 'POST', body }); notice(result, '导入成功', true); await loadStats(); await loadCompanies(); } catch (error) { notice(result, error.message); } }); }
  $('searchCompanies').onclick = () => loadCompanies(1); $('previousCompanies').onclick = () => loadCompanies(Math.max(1, state.page - 1)); $('nextCompanies').onclick = () => loadCompanies(Math.min(state.pages, state.page + 1)); $('loadOutreach').onclick = loadOutreach; $('loadSchema').onclick = loadSchema; $('enqueueResearch').onclick = async () => { try { await json('/research/tasks', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({company_id: $('researchCompany').value, task_type: $('researchType').value})}); notice('researchResult', '任务已创建', true); await loadResearch(); } catch (error) { notice('researchResult', error.message); } }; $('runResearch').onclick = async () => { try { await json('/research/run?limit=10', {method:'POST'}); notice('researchResult', '任务执行完成', true); await loadResearch(); await loadStats(); await loadCompanies(); } catch (error) { notice('researchResult', error.message); } }; $('checkEmail').onclick = async () => { try { const data = await json(`/outreach/email-check?email=${encodeURIComponent($('email').value)}`, {method:'POST'}); notice('emailResult', data.suppressed ? `禁止发送：${data.reason || '已抑制'}` : '该邮箱可以使用', !data.suppressed); } catch (error) { notice('emailResult', error.message); } };
  document.querySelectorAll('.tab').forEach((tab) => tab.onclick = () => { document.querySelectorAll('.tab').forEach(x => x.classList.remove('active')); tab.classList.add('active'); document.querySelectorAll('main section.panel').forEach(x => x.classList.add('hidden')); $(tab.dataset.target).classList.remove('hidden'); if (tab.dataset.target === 'research') loadResearch(); if (tab.dataset.target === 'outreach') loadOutreach(); if (tab.dataset.target === 'database') loadSchema(); });
  upload($('customerForm'), '/imports/csv', 'customerResult'); upload($('suppressionForm'), '/outreach/suppressions/csv', 'suppressionResult'); loadStats(); loadCompanies();
})();
