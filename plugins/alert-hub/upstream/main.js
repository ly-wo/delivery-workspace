import { pluginFetch as fetch, pluginStorage as localStorage, pluginConfirm, host } from '../bridge';
import './style.css';
import './team-management.css';

const state = {
  currentCaseId: null,
  currentPage: 'dashboard',
  cases: [],
  casesTotal: 0,
  casesOffset: 0,
  casesHasMore: false,
  eventsTotal: 0,
  eventsOffset: 0,
  eventsHasMore: false,
  events: [],
  todos: [],
  todosTotal: 0,
  todosOffset: 0,
  todosHasMore: false,
  owners: [],
  people: [],
  teams: [],
  rules: [],
  fingerprintRules: [],
  notificationChannels: [],
  notificationPolicies: [],
  notificationRoutes: [],
  notificationDeliveries: [],
  me: null,
  auth: null,
  authRequired: false,
  filterOptions: null,
  pending: new Set(),
  inflight: new Map(),
  lastQuery: {},
  lastRefresh: {},
  caseCache: new Map(),
  caseEventsCache: new Map(),
  eventCache: new Map(),
  diagnostics: null,
  currentCaseDetailTab: 'overview',
  caseRiskFilter: '',
  dashboardTrendMode: 'volume',
  dashboardServiceTrendMetric: 'events',
  dashboardServiceTrendSelection: new Set(),
  dashboardServiceTrendSignature: '',
  querySlots: {
    dashboard: { seq: 0, controller: null },
    cases: { seq: 0, controller: null },
    events: { seq: 0, controller: null },
    todos: { seq: 0, controller: null },
  },
  catalogEpoch: 0,
};

const DASHBOARD_PRIMARY_SECTIONS = ['summary', 'attention', 'report'];
const DASHBOARD_DEFERRED_SECTIONS = [
  ['trends'],
  ['breakdowns'],
  ['dimension_trends'],
];

const NAV_GROUPS = [
  {
    items: [
      {
        id: 'dashboard',
        label: '工作台',
        description: '值班概览与处置健康',
        iconClass: 'nav-icon-dashboard',
      },
    ],
  },
  {
    id: 'response',
    label: '处置',
    description: '确认、分派、恢复',
    items: [
      { id: 'my', label: '我的告警', description: '当前负责人待处理', iconClass: 'nav-icon-my' },
      { id: 'team', label: '团队告警', description: '按 Owner 归属汇总', iconClass: 'nav-icon-team' },
      { id: 'cases', label: '全部 Case', description: '合并后的问题视图', iconClass: 'nav-icon-cases' },
      { id: 'events', label: '事件流', description: '原始事件与补全状态', iconClass: 'nav-icon-events' },
      { id: 'todos', label: 'Todo', description: '跟进项和复盘任务', iconClass: 'nav-icon-todos' },
    ],
  },
  {
    id: 'governance',
    label: '治理',
    description: '归属、降噪、质量',
    items: [
      { id: 'owners', label: '路由与人员', description: '服务 Owner 和通知目标', iconClass: 'nav-icon-owners' },
      { id: 'people', label: '人员目录', description: '可指派人员和企微 ID', iconClass: 'nav-icon-people' },
      { id: 'teams', label: '团队维护', description: '团队目录与 Jira 映射', iconClass: 'nav-icon-teams' },
      { id: 'rules', label: '规则治理', description: '抑制、降级、路由规则', iconClass: 'nav-icon-rules' },
      { id: 'fingerprints', label: '指纹规则', description: '归并模板和样例预览', iconClass: 'nav-icon-rules' },
      { id: 'notifications', label: '通知策略', description: '渠道、策略与服务路由', iconClass: 'nav-icon-notifications' },
      { id: 'diagnostics', label: '接入诊断', description: '回调、通知和补全健康', iconClass: 'nav-icon-diagnostics' },
    ],
  },
  {
    id: 'tools',
    label: '工具',
    description: '受控导入',
    items: [
      { id: 'ingest', label: '手工导入', description: '验证模板和样例数据', iconClass: 'nav-icon-ingest' },
    ],
  },
];

function getNavItem(pageId) {
  for (const group of NAV_GROUPS) {
    const item = group.items.find((entry) => entry.id === pageId);
    if (item) return { ...item, group };
  }
  return null;
}

function getPageTitle(pageId) {
  return getNavItem(pageId)?.label || 'Alert Hub';
}

function getPageDescription(pageId) {
  return getNavItem(pageId)?.description || '';
}

function renderSidebar(activePage = state.currentPage) {
  const nav = $('#sidebar-nav');
  if (!nav) return;

  nav.replaceChildren();
  for (const group of NAV_GROUPS) {
    if (group.label) {
      const groupEl = document.createElement('div');
      groupEl.className = 'nav-group-label';
      const title = document.createElement('span');
      title.textContent = group.label;
      groupEl.appendChild(title);
      if (group.description) {
        const hint = document.createElement('small');
        hint.textContent = group.description;
        groupEl.appendChild(hint);
      }
      nav.appendChild(groupEl);
    }

    for (const item of group.items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nav-btn';
      btn.dataset.page = item.id;
      const active = item.id === activePage;
      if (active) {
        btn.classList.add('active');
        btn.setAttribute('aria-current', 'page');
      }

      const icon = document.createElement('span');
      icon.className = `nav-icon ${item.iconClass}`;
      icon.setAttribute('aria-hidden', 'true');

      const copy = document.createElement('span');
      copy.className = 'nav-copy';

      const label = document.createElement('span');
      label.className = 'nav-label';
      label.textContent = item.label;

      const hint = document.createElement('span');
      hint.className = 'nav-hint';
      hint.textContent = item.description;

      copy.append(label, hint);
      btn.append(icon, copy);
      nav.appendChild(btn);
    }
  }
}

function bindNavEvents() {
  $$('.nav-btn').forEach((b) => {
    b.addEventListener('click', () => showPage(b.dataset.page));
    b.addEventListener('mouseenter', () => prefetchPage(b.dataset.page));
    b.addEventListener('focus', () => prefetchPage(b.dataset.page));
  });
}

const ATTENTION_STATUSES = new Set(['open', 'acked', 'triaged', 'fixing']);
const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
const PAGE_FRESH_MS = 45 * 1000;
const DETAIL_FRESH_MS = 30 * 1000;
const FILTER_OPTIONS_FRESH_MS = 5 * 60 * 1000;
const FALLBACK_FILTER_OPTIONS = {
  case: {
    statuses: ['open', 'acked', 'triaged', 'fixing', 'resolved', 'closed', 'noise'],
    severities: ['critical', 'high', 'medium', 'low'],
    services: [],
    assignees: [],
    environments: [],
  },
  event: {
    services: [],
    environments: [],
    suppressed: ['false', 'true'],
  },
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function dataPage(page) {
  return page === 'my' || page === 'team' ? 'cases' : page;
}

function currentDataPage() {
  return dataPage(state.currentPage);
}

function userId() {
  if (state.auth?.authenticated && state.auth.user_id) {
    return state.auth.user_id;
  }
  const v = localStorage.getItem('alert-hub-user') || $('#user-id')?.value?.trim();
  return v || 'anonymous';
}

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (!state.authRequired) {
    h['X-User-ID'] = userId();
  }
  return h;
}

function exportHeaders() {
  const h = {};
  if (!state.authRequired) {
    h['X-User-ID'] = userId();
  }
  return h;
}

function isQueryAbortError(err) {
  return err?.name === 'AbortError' || (err instanceof DOMException && err.name === 'AbortError');
}

function beginQueryRequest(resource, { append = false } = {}) {
  const slot = state.querySlots[resource];
  if (!append) {
    slot.controller?.abort();
    slot.controller = new AbortController();
    slot.seq += 1;
  }
  const requestSeq = slot.seq;
  const signal = slot.controller?.signal;
  return {
    signal,
    isStale: () => requestSeq !== slot.seq,
  };
}

function invalidateQueryRequests() {
  for (const slot of Object.values(state.querySlots)) {
    slot.controller?.abort();
    slot.controller = null;
    slot.seq += 1;
  }
}

async function api(path, opts = {}) {
  const epoch = state.catalogEpoch;
  let res;
  try {
    res = await fetch(path, {
      ...opts,
      credentials: 'same-origin',
      headers: { ...headers(), ...(opts.headers || {}) },
    });
  } catch (err) {
    if (isQueryAbortError(err)) throw err;
    throw err;
  }
  let text;
  try {
    text = await res.text();
  } catch (err) {
    if (isQueryAbortError(err)) throw err;
    throw err;
  }
  if ((!opts.method || opts.method === 'GET') && epoch !== state.catalogEpoch) {
    if (opts.signal?.aborted) throw opts.signal.reason || new DOMException('Aborted', 'AbortError');
    return api(path, opts);
  }
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (res.status === 401 && state.authRequired && !path.includes('/api/auth/')) {
    showLogin('登录已过期，请重新登录');
    throw new Error(data?.error || 'unauthorized');
  }
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}

function runOnce(key, fn) {
  key = `${state.catalogEpoch}:${key}`;
  if (state.inflight.has(key)) return state.inflight.get(key);
  const task = Promise.resolve()
    .then(fn)
    .finally(() => state.inflight.delete(key));
  state.inflight.set(key, task);
  return task;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2500);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function short(s, n) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n) + '…' : str;
}

function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

function fmtAge(t) {
  if (!t) return '—';
  const at = new Date(t).getTime();
  if (Number.isNaN(at)) return '—';
  const ms = Date.now() - at;
  if (ms < 0) return '刚刚';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

function eventReceiveTimeCell(ev) {
  const received = ev.created_at || ev.timestamp;
  const occurred = ev.timestamp;
  const receivedMs = received ? new Date(received).getTime() : NaN;
  const occurredMs = occurred ? new Date(occurred).getTime() : NaN;
  const showOccurred = Number.isFinite(receivedMs)
    && Number.isFinite(occurredMs)
    && Math.abs(receivedMs - occurredMs) > 60000;
  const title = showOccurred
    ? `接收: ${fmtTime(received)}\n发生: ${fmtTime(occurred)}`
    : fmtTime(received);
  const occurredText = showOccurred ? `<div class="subtle">发生 ${esc(fmtAge(occurred))}</div>` : '';
  return `<td title="${esc(title)}">${esc(fmtAge(received))}${occurredText}</td>`;
}

function markRefresh(page) {
  state.lastRefresh[page] = new Date();
  if (currentDataPage() === page) updateRefreshIndicator();
}

function isFresh(page, ttl = PAGE_FRESH_MS) {
  page = dataPage(page);
  const ts = state.lastRefresh[page];
  return Boolean(ts && Date.now() - ts.getTime() < ttl);
}

function hasPageData(page) {
  page = dataPage(page);
  if (page === 'dashboard') return Boolean(state.lastRefresh.dashboard);
  if (page === 'cases') return state.cases.length > 0 || Boolean(state.lastRefresh.cases);
  if (page === 'events') return state.events.length > 0 || Boolean(state.lastRefresh.events);
  if (page === 'todos') return state.todos.length > 0 || Boolean(state.lastRefresh.todos);
  if (page === 'owners') return state.owners.length > 0 || Boolean(state.lastRefresh.owners);
  if (page === 'people') return state.people.length > 0 || Boolean(state.lastRefresh.people);
  if (page === 'teams') return state.teams.length > 0 || Boolean(state.lastRefresh.teams);
  if (page === 'rules') return state.rules.length > 0 || Boolean(state.lastRefresh.rules);
  if (page === 'fingerprints') return state.fingerprintRules.length > 0 || Boolean(state.lastRefresh.fingerprints);
  if (page === 'notifications') return Boolean(state.lastRefresh.notifications);
  if (page === 'diagnostics') return Boolean(state.lastRefresh.diagnostics);
  return false;
}

function setRefreshing(page, on) {
  const key = `refresh:${page}`;
  setPending(key, on);
  const el = $('#refresh-indicator');
  if (!el || currentDataPage() !== page) return;
  if (on) {
    el.textContent = '刷新中…';
    el.classList.remove('stale');
  } else {
    updateRefreshIndicator();
  }
}

function setButtonBusy(button, busy, busyText, idleText) {
  if (!button) return;
  button.disabled = busy;
  button.textContent = busy ? busyText : idleText;
}

function setButtonBusyPreserve(button, busy, busyText) {
  if (!button) return;
  if (!button.dataset.idleText) button.dataset.idleText = button.textContent;
  setButtonBusy(button, busy, busyText, button.dataset.idleText);
}

function updateRefreshIndicator() {
  const el = $('#refresh-indicator');
  if (!el) return;
  const ts = state.lastRefresh[currentDataPage()];
  if (!ts) {
    el.textContent = '';
    el.classList.remove('stale');
    return;
  }
  const ageMs = Date.now() - ts.getTime();
  const stale = ageMs > 5 * 60 * 1000;
  el.textContent = `更新于 ${ts.toLocaleTimeString()}`;
  el.classList.toggle('stale', stale);
  el.title = stale ? '数据可能已过期，建议刷新' : '最近刷新时间';
}

function setPending(key, on) {
  if (on) state.pending.add(key);
  else state.pending.delete(key);
}

function isPending(key) {
  return state.pending.has(key);
}

function badge(status) {
  const cls = String(status || 'unknown').toLowerCase();
  return `<span class="badge badge-${esc(cls)}">${esc(status)}</span>`;
}

function severityBadge(sev) {
  const cls = String(sev || 'unknown').toLowerCase();
  return `<span class="severity severity-${esc(cls)}">${esc(sev || '—')}</span>`;
}

const unclassifiedServiceNames = new Set([
  'tencent-cls',
  'tencent-cls-poll',
  'cls 聚合告警',
]);

function isUnclassifiedService(service) {
  const value = String(service || '').trim();
  const lower = value.toLowerCase();
  if (!value || lower === 'unknown') return true;
  return unclassifiedServiceNames.has(lower);
}

function isAlarmMetadataEvent(ctx) {
  return String(ctx?.source_type || '').toLowerCase() === 'alarm_metadata';
}

function displayService(service, ctx = null) {
  if (ctx && isAlarmMetadataEvent(ctx)) {
    const value = String(service || '').trim();
    if (value && !isUnclassifiedService(value)) {
      return '策略级告警';
    }
    return '未识别服务（聚合）';
  }
  const value = String(service || '').trim();
  if (value && !isUnclassifiedService(value)) return value;
  return '未识别服务';
}

function serviceDisplayTitle(service, ctx = null) {
  if (ctx && isAlarmMetadataEvent(ctx)) {
    const value = String(service || '').trim();
    if (value && !isUnclassifiedService(value)) {
      return `CLS 策略级聚合告警（标签服务：${value}），缺少业务日志明细，未形成 Case`;
    }
    return 'CLS 策略级聚合告警，payload 中缺少业务日志明细与可识别服务';
  }
  const value = String(service || '').trim();
  if (!isUnclassifiedService(value)) return '';
  if (ctx && isCLSContext(ctx) && !hasServiceLabelEvidence(ctx)) {
    return '来源为 CLS 策略级聚合告警，payload 中缺少可识别的服务标签或 owner 匹配信息';
  }
  return '';
}

function isCLSContext(ctx) {
  const src = String(ctx?.source || ctx?.cls_source || '').toLowerCase();
  return src.includes('cls') || src === 'tencent-cls' || src === 'tencent-cls-poll';
}

function hasServiceLabelEvidence(ctx) {
  const labels = ctx?.labels || {};
  return Boolean(labels.service || labels.Service || labels.module || labels.app);
}

function emptyRow(colSpan, text = '暂无数据') {
  return `<tr><td colspan="${colSpan}" class="empty-cell">${esc(text)}</td></tr>`;
}

function fillTable(sel, rows, rowFn, colSpan = 2) {
  const tb = $(sel);
  tb.innerHTML = rows.length ? rows.map(rowFn).join('') : emptyRow(colSpan);
}

function primaryCaseAction(status) {
  const map = {
    open: ['确认 ACK', 'ack'],
    acked: ['标记修复中', 'fixing'],
    triaged: ['标记修复中', 'fixing'],
    fixing: ['标记已解决', 'resolve'],
    resolved: ['关闭 Case', 'close'],
    closed: ['重新打开', 'reopen'],
    noise: ['重新打开', 'reopen'],
  };
  return map[status] || null;
}

function secondaryCaseActions(status) {
  const byStatus = {
    open: [['标记噪声', 'noise']],
    acked: [['标记已解决', 'resolve'], ['标记噪声', 'noise']],
    triaged: [['标记已解决', 'resolve'], ['标记噪声', 'noise']],
    fixing: [['标记噪声', 'noise']],
    resolved: [['重新打开', 'reopen']],
    closed: [],
    noise: [],
  };
  return byStatus[status] || [];
}

function attentionScore(c) {
  const sev = SEVERITY_ORDER[String(c.severity).toLowerCase()] ?? 9;
  const statusRank = { open: 0, acked: 1, triaged: 2, fixing: 3 }[c.status] ?? 9;
  const last = c.last_seen ? new Date(c.last_seen).getTime() : 0;
  return sev * 1000 + statusRank * 100 - last / 1e10;
}

function sortAttentionCases(cases) {
  return cases
    .filter((c) => ATTENTION_STATUSES.has(c.status))
    .sort((a, b) => attentionScore(a) - attentionScore(b));
}

function showPage(name, opts = {}) {
  state.currentPage = name;
  const section = dataPage(name);
  if (!opts.preserveCaseFilters) applyPagePreset(name);
  $$('.page').forEach((p) => p.classList.remove('active'));
  $$('.nav-btn').forEach((b) => {
    const active = b.dataset.page === name;
    b.classList.toggle('active', active);
    if (active) {
      b.setAttribute('aria-current', 'page');
    } else {
      b.removeAttribute('aria-current');
    }
  });
  $(`#page-${section}`)?.classList.add('active');
  const titleEl = $('#page-title');
  const subtitleEl = $('#page-subtitle');
  if (titleEl) titleEl.textContent = getPageTitle(name);
  if (subtitleEl) subtitleEl.textContent = getPageDescription(name);
  updateRefreshIndicator();
  loadPageData(name, { quiet: hasPageData(name) });
  prefetchNearbyData(name);
}

function applyPagePreset(name) {
  if (!['my', 'team', 'cases'].includes(name)) return;
  const preset = name === 'my' ? 'mine' : name === 'team' ? 'team' : 'all';
  setCaseDefaultFilters(preset);
}

function setCaseDefaultFilters(scope) {
  if ($('#case-view')) $('#case-view').value = 'active';
  if ($('#case-scope')) $('#case-scope').value = scope;
  ['q', 'status', 'service', 'severity', 'assignee', 'env'].forEach((k) => {
    const el = $(`#case-${k}`);
    if (el) el.value = '';
  });
}

function loadPageData(name, opts = {}) {
  const page = dataPage(name);
  if (page === 'dashboard') return loadDashboard(opts);
  if (page === 'cases') {
    return loadFilterOptions({ quiet: true, force: opts.force })
      .finally(() => loadCases(opts));
  }
  if (page === 'events') {
    return loadFilterOptions({ quiet: true, force: opts.force })
      .finally(() => loadEvents(opts));
  }
  if (page === 'todos') return loadTodos(opts);
  if (page === 'owners') return loadOwners(opts);
  if (page === 'people') return loadPeople(opts);
  if (page === 'teams') return loadTeams(opts);
  if (page === 'rules') return loadRules(opts);
  if (page === 'fingerprints') return loadFingerprintRules(opts);
  if (page === 'notifications') return loadNotifications(opts);
  if (page === 'diagnostics') return loadDiagnostics(opts);
  return Promise.resolve();
}

function prefetchNearbyData(page) {
  const section = dataPage(page);
  if (section === 'dashboard') {
    void loadFilterOptions({ quiet: true });
    void ensurePeopleLoaded();
    void loadDiagnostics({ quiet: true, prefetch: true });
    return;
  }
  if (section === 'cases') {
    void ensurePeopleLoaded();
    void loadEvents({ quiet: true, prefetch: true });
    return;
  }
  if (section === 'owners') {
    void ensurePeopleLoaded();
    void loadRules({ quiet: true });
  }
  if (section === 'diagnostics') {
    void loadRules({ quiet: true });
  }
}

function prefetchPage(name) {
  if (!name || name === state.currentPage) return;
  if (hasPageData(name) && isFresh(name)) return;
  void loadPageData(name, { quiet: true }).catch(() => {});
}

async function ensurePeopleLoaded({ force = false } = {}) {
  if (!force && state.people.length && isFresh('people', FILTER_OPTIONS_FRESH_MS)) return state.people;
  try {
    return await runOnce('people', async () => {
      const data = await api('/api/people');
      state.people = data.items || [];
      markRefresh('people');
      populatePeopleDatalist();
      return state.people;
    });
  } catch {
    state.people = [];
    return state.people;
  }
}

function activePeople() {
  return (state.people || []).filter((p) => p.status === 'active');
}

function findActivePerson(username) {
  const key = String(username || '').trim().toLowerCase();
  if (!key) return null;
  return activePeople().find((p) => String(p.username || '').trim().toLowerCase() === key) || null;
}

function personMetaText(person) {
  if (!person) return '';
  const parts = [];
  if (person.name) parts.push(person.name);
  if (person.team) parts.push(person.team);
  if (person.wecom_userid) parts.push(`企微 ${person.wecom_userid}`);
  return parts.join(' · ') || person.username;
}

function renderOwnerPersonMeta(inputID, metaID) {
  const input = $(inputID);
  const meta = $(metaID);
  if (!input || !meta) return null;
  const username = input.value.trim();
  const person = findActivePerson(username);
  meta.classList.remove('ok', 'warn');
  if (!username) {
    meta.textContent = '';
    return null;
  }
  if (person) {
    meta.textContent = personMetaText(person);
    meta.classList.add('ok');
    return person;
  }
  meta.textContent = '未匹配人员，团队和企微ID不会自动带出';
  meta.classList.add('warn');
  return null;
}

function teamLabel(t) {
  if (!t) return '—';
  const name = t.display_name || t.name || t.id;
  if (t.merged_into_team_id) return `${name}（已合并）`;
  return t.enabled === false ? `${name}（已停用）` : name;
}

function populateTeamSelect(selectEl, { selectedID = '', includeEmpty = true, emptyLabel = '未绑定团队', freeText = false } = {}) {
  if (!selectEl) return;
  const opts = includeEmpty ? [`<option value="">${esc(emptyLabel)}</option>`] : [];
  for (const t of state.teams) {
    const unavailable = t.enabled === false || !!t.merged_into_team_id;
    if (unavailable && t.id !== selectedID) continue;
    opts.push(`<option value="${esc(t.id)}" ${unavailable ? 'disabled' : ''}>${esc(teamLabel(t))}</option>`);
  }
  if (freeText) opts.push('<option value="__free__">未登记团队</option>');
  if (selectedID && selectedID !== '__free__' && !state.teams.some(t => t.id === selectedID)) {
    opts.push(`<option value="${esc(selectedID)}" disabled>团队不可用</option>`);
  }
  selectEl.innerHTML = opts.join('');
  selectEl.value = selectedID;
}

function setTeamField(prefix, entity = {}) {
  const match = !entity.team_id && state.teams.find(t => t.name === entity.team || (t.aliases || []).includes(entity.team));
  const id = entity.team_id || match?.id || (entity.team ? '__free__' : '');
  populateTeamSelect($( `#${prefix}-team`), { selectedID: id, freeText: true });
  $(`#${prefix}-team-free`).value = id === '__free__' ? entity.team || '' : '';
  updateTeamFreeField(prefix);
}

function updateTeamFreeField(prefix) {
  const free = $(`#${prefix}-team`).value === '__free__';
  const input = $(`#${prefix}-team-free`);
  input.classList.toggle('hidden', !free);
  input.required = free;
}

function readTeamField(prefix) {
  const id = $(`#${prefix}-team`).value;
  if (id === '__free__') return { team_id: '', team: $(`#${prefix}-team-free`).value.trim() };
  const t = state.teams.find(team => team.id === id);
  return { team_id: id, team: t ? t.display_name || t.name : '' };
}

let ownerAutoTeam = true;
let ownerPrimarySeen = '';

function primaryTeamEntity(person) {
  if (!person) return null;
  const t = state.teams.find((team) => team.id === person.team_id);
  if (person.team_id) {
    if (!t || t.enabled === false || t.merged_into_team_id) return null;
    return person;
  }
  if (person.team) return person;
  return null;
}

function ownerTeamDiffersFromPrimary(primary) {
  const usable = primaryTeamEntity(primary);
  if (!usable) return false;
  const current = readTeamField('owner');
  if (usable.team_id) return current.team_id !== usable.team_id;
  return current.team_id !== '' || current.team !== (usable.team || '');
}

function updateOwnerTeamFollowButton(primary) {
  const btn = $('#owner-team-follow');
  if (!btn) return;
  const usable = primaryTeamEntity(primary);
  const show = !!usable && (!ownerAutoTeam || ownerTeamDiffersFromPrimary(primary));
  btn.classList.toggle('hidden', !show);
}

function restoreOwnerTeamFollow() {
  ownerAutoTeam = true;
  const primary = findActivePerson($('#owner-primary').value.trim());
  const usable = primaryTeamEntity(primary);
  if (usable) setTeamField('owner', usable);
  syncOwnerDerivedFields();
}

function syncOwnerDerivedFields() {
  const primary = renderOwnerPersonMeta('#owner-primary', '#owner-primary-meta');
  const backup = renderOwnerPersonMeta('#owner-backup', '#owner-backup-meta');
  const username = $('#owner-primary').value.trim();
  if (username !== ownerPrimarySeen) {
    $('#owner-notify').value = primary?.wecom_userid || '';
    if (ownerAutoTeam) {
      setTeamField('owner', primaryTeamEntity(primary) || {});
    }
    ownerPrimarySeen = username;
  }
  const hint = $('#owner-routing-hint');
  const parts = [];
  if (username) {
    if (!primary) parts.push('未登记人员；保存时创建人员账号');
    else if (!primary.wecom_userid) parts.push('负责人未配置企微账号，无法 @');
    if (!ownerAutoTeam) parts.push('服务团队已手动指定，不随负责人变化');
  }
  hint.classList.toggle('warn', !!username && (!primary || !primary.wecom_userid));
  hint.textContent = parts.join(' · ');
  updateOwnerTeamFollowButton(primary);
  return { primary, backup };
}

function populateAssigneeSelect(selected = '') {
  const sel = $('#assign-input');
  if (!sel) return;
  const options = activePeople().map((p) => {
    const label = p.name ? `${p.username} (${p.name})` : p.username;
    const selAttr = p.username === selected ? ' selected' : '';
    return `<option value="${esc(p.username)}"${selAttr}>${esc(label)}</option>`;
  }).join('');
  sel.innerHTML = `<option value="">选择负责人</option>${options}`;
}

function populatePeopleDatalist() {
  const list = $('#people-usernames');
  if (!list) return;
  list.innerHTML = activePeople().map((p) => `<option value="${esc(p.username)}"></option>`).join('');
}

function populateTeamsDatalist() {
  for (const prefix of ['person', 'owner']) {
    if (!$(`#${prefix}-dialog`)?.open) populateTeamSelect($(`#${prefix}-team`), { freeText: true });
  }
  applyDashboardTeamOptions();
}

async function ensureTeamsLoaded({ force = false } = {}) {
  if (!force && state.teams.length && isFresh('teams', FILTER_OPTIONS_FRESH_MS)) return state.teams;
  try {
    return await runOnce('teams', async () => {
      const data = await api('/api/teams');
      state.teams = data.items || [];
      markRefresh('teams');
      populateTeamsDatalist();
      return state.teams;
    });
  } catch {
    return state.teams;
  }
}

function openPasswordDialog() {
  if (!state.auth?.can_change_password) {
    toast('当前账号不支持本地改密码（LDAP 用户请联系管理员）');
    return;
  }
  $('#password-old').value = '';
  $('#password-new').value = '';
  $('#password-confirm').value = '';
  $('#password-error')?.classList.add('hidden');
  $('#password-success')?.classList.add('hidden');
  $('#password-dialog-hint')?.classList.add('hidden');
  $('#password-save').disabled = false;
  $('#password-save').textContent = '保存';
  $('#password-dialog')?.showModal();
}

async function submitPasswordChange(e) {
  e.preventDefault();
  const btn = $('#password-save');
  const errEl = $('#password-error');
  const okEl = $('#password-success');
  errEl?.classList.add('hidden');
  okEl?.classList.add('hidden');
  const oldPassword = $('#password-old').value;
  const newPassword = $('#password-new').value;
  const confirmPassword = $('#password-confirm').value;
  if (newPassword.length < 8) {
    errEl.textContent = '新密码至少 8 位';
    errEl.classList.remove('hidden');
    return;
  }
  if (newPassword !== confirmPassword) {
    errEl.textContent = '两次输入的新密码不一致';
    errEl.classList.remove('hidden');
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = '保存中…';
  }
  try {
    const res = await fetch('/api/auth/password', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      errEl.textContent = data.error || '修改密码失败';
      errEl.classList.remove('hidden');
      return;
    }
    okEl.textContent = '密码已更新';
    okEl.classList.remove('hidden');
    setTimeout(() => $('#password-dialog')?.close(), 800);
  } catch (err) {
    errEl.textContent = err.message || '修改密码失败';
    errEl.classList.remove('hidden');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '保存';
    }
  }
}

function refreshCurrentPage() {
  loadPageData(state.currentPage, { force: true, quiet: hasPageData(state.currentPage) });
}

async function loadMe() {
  const el = $('#user-profile');
  el.title = '';
  try {
    state.me = await api('/api/me');
    const teams = (state.me.teams || []).join(', ') || '—';
    const ownedServices = state.me.owned_services || [];
    const backupServices = state.me.backup_services || [];
    const ownedLabel = String(ownedServices.length);
    const backupLabel = String(backupServices.length);
    el.textContent = `团队: ${teams} · 负责: ${ownedLabel} · 备份: ${backupLabel}`;
    el.title = `负责: ${ownedServices.length ? ownedServices.join(', ') : '无'}\n备份: ${backupServices.length ? backupServices.join(', ') : '无'}`;
  } catch {
    el.textContent = '';
    el.title = '';
  }
}

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (res.status === 401) {
      state.authRequired = true;
      state.auth = { authenticated: false };
      showLogin();
      return false;
    }
    const data = await res.json();
    state.auth = data;
    state.authRequired = !!data.authenticated;
    showAppShell(data);
    return true;
  } catch {
    showAppShell({ authenticated: false });
    return true;
  }
}

function showLogin(msg) {
  $('#login-screen').classList.remove('hidden');
  $('#app-shell').classList.add('hidden');
  $('#login-error').classList.toggle('hidden', !msg);
  if (msg) $('#login-error').textContent = msg;
}

function showAppShell(authUser) {
  $('#login-screen').classList.add('hidden');
  $('#app-shell').classList.remove('hidden');
  const usingSession = authUser?.authenticated;
  $('#header-user-label').classList.toggle('hidden', usingSession);
  $('#logout-btn').classList.toggle('hidden', !usingSession);
  const canChangePassword = usingSession && authUser?.can_change_password;
  $('#change-password-btn')?.classList.toggle('hidden', !canChangePassword);
  if (usingSession) {
    const label = authUser.name || authUser.username || authUser.user_id;
    $('#auth-user').textContent = `${label} (${authUser.idp || 'session'})`;
  } else {
    $('#auth-user').textContent = '';
  }
}

async function submitLogin(e) {
  e.preventDefault();
  $('#login-error').classList.add('hidden');
  const username = $('#login-username').value.trim();
  const password = $('#login-password').value;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      $('#login-error').textContent = data.error || '登录失败';
      $('#login-error').classList.remove('hidden');
      return;
    }
    state.auth = data;
    state.auth.authenticated = true;
    state.authRequired = true;
    showAppShell(state.auth);
    await loadMe();
    await loadFilterOptions();
    openInitialRoute();
  } catch (err) {
    $('#login-error').textContent = err.message || '登录失败';
    $('#login-error').classList.remove('hidden');
  }
}

function initialRoute() {
  const params = new URLSearchParams(window.location.search);
  const caseID = params.get('case_id') || params.get('caseId');
  if (caseID) {
    return { page: 'cases', caseID };
  }
  const page = params.get('page');
  if (page && getNavItem(page)) {
    return { page };
  }
  return { page: 'dashboard' };
}

function openInitialRoute() {
  const route = initialRoute();
  if (route.caseID) {
    showPage('cases');
    void openCase(route.caseID, { force: true });
    return;
  }
  showPage(route.page);
}

async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch { /* ignore */ }
  state.auth = null;
  showLogin();
}

function renderAttentionQueue(cases) {
  const rows = sortAttentionCases(cases).slice(0, 20);
  const emptyEl = $('#attention-empty');
  const table = $('#attention-queue');
  if (!rows.length) {
    emptyEl?.classList.remove('hidden');
    table?.classList.add('hidden');
    return;
  }
  emptyEl?.classList.add('hidden');
  table?.classList.remove('hidden');
  fillTable('#attention-queue tbody', rows, (c) => `
    <tr data-id="${esc(c.id)}" class="attention-row">
      <td>${severityBadge(c.severity)}</td>
      <td title="${esc(serviceDisplayTitle(c.service, c))}">${esc(displayService(c.service, c))}</td>
      <td title="${esc(c.title)}">${esc(short(c.title, 48))}</td>
      <td>${badge(c.status)}</td>
      <td>${esc(c.assignee || '—')}</td>
      <td title="${esc(fmtTime(c.last_seen))}">${esc(fmtAge(c.last_seen))}</td>
      <td><button type="button" class="btn btn-sm btn-link" data-goto="${esc(c.id)}">处理</button></td>
    </tr>`, 7);
  $$('#attention-queue tbody tr').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('[data-goto]')) return;
      gotoCase(tr.dataset.id);
    });
  });
  $$('#attention-queue [data-goto]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      gotoCase(btn.dataset.goto);
    });
  });
}

async function loadAttentionQueue() {
  $('#attention-loading')?.classList.remove('hidden');
  try {
    const data = await api('/api/cases?scope=all&active=true&limit=20');
    renderAttentionQueue(data.items || []);
  } catch {
    renderAttentionQueue([]);
  } finally {
    $('#attention-loading')?.classList.add('hidden');
  }
}

async function reclassifyServices() {
  const btn = $('#reclassify-services');
  const key = 'reclassify-services';
  if (isPending(key)) return;
  setPending(key, true);
  if (btn) {
    btn.disabled = true;
    btn.textContent = '识别中…';
  }
  try {
    let status = await api('/api/cases/reclassify-services', { method: 'POST', body: '{}' });
    while (status.status === 'running') {
      await new Promise((resolve) => setTimeout(resolve, 500));
      status = await api('/api/cases/reclassify-services');
    }
    if (status.status === 'failed') {
      throw new Error(status.error || '重识别失败');
    }
    const result = status.result || {};
    toast(`已更新 ${result.cases_updated ?? 0} 个 Case、${result.events_updated ?? 0} 条事件；仍有 ${result.still_unknown ?? 0} 个未识别`);
    await loadDashboard({ quiet: true, force: true });
    if (state.currentPage === 'cases') {
      await loadFilterOptions({ quiet: true, force: true });
      await loadCases({ quiet: true, force: true });
    }
  } catch (err) {
    toast(`重识别失败：${err.message}`);
  } finally {
    setPending(key, false);
    if (btn) {
      btn.disabled = false;
      btn.textContent = '重识别服务';
    }
  }
}

async function loadDashboard({ quiet = false, force = false } = {}) {
  const params = dashboardQueryParams();
  const queryKey = params.toString();
  if (!force && state.lastQuery.dashboard === queryKey && isFresh('dashboard')) return;
  const { signal, isStale } = beginQueryRequest('dashboard');
  const quietMode = quiet && hasPageData('dashboard');
  if (quietMode) setRefreshing('dashboard', true);
  else $('#dashboard-loading').classList.remove('hidden');
  $('#dashboard-error').classList.add('hidden');
  if (!quietMode) $('#dashboard-content').classList.add('hidden');
  setButtonBusyPreserve($('#dashboard-refresh'), true, '应用中…');
  try {
    const [primaryDashboard] = await Promise.all([
      api(dashboardURL(params, DASHBOARD_PRIMARY_SECTIONS), { signal }),
      ensureDashboardFilterOptions(force),
      ensureTeamsLoaded(),
    ]);
    if (isStale()) return;
    state.lastQuery.dashboard = queryKey;
    let dashboard = mergeDashboardSections(emptyDashboard(primaryDashboard.range), primaryDashboard, DASHBOARD_PRIMARY_SECTIONS);
    renderDashboard(dashboard);
    $('#dashboard-loading').classList.add('hidden');
    $('#dashboard-content').classList.remove('hidden');
    markRefresh('dashboard');

    const deferred = await Promise.allSettled(DASHBOARD_DEFERRED_SECTIONS.map(async (sections) => ({
      sections,
      data: await api(dashboardURL(params, sections), { signal }),
    })));
    if (isStale()) return;
    let failed = 0;
    for (const item of deferred) {
      if (item.status === 'fulfilled') {
        dashboard = mergeDashboardSections(dashboard, item.value.data, item.value.sections);
        renderDashboard(dashboard);
      } else if (!isQueryAbortError(item.reason)) {
        failed += 1;
      }
    }
    if (failed > 0) {
      toast(`Dashboard 部分图表加载失败：${failed} 个模块`);
    }
  } catch (e) {
    if (isStale() || isQueryAbortError(e)) return;
    $('#dashboard-loading').classList.add('hidden');
    $('#dashboard-error').textContent = e.message;
    $('#dashboard-error').classList.remove('hidden');
  } finally {
    if (!isStale()) {
      setRefreshing('dashboard', false);
      setButtonBusyPreserve($('#dashboard-refresh'), false, '应用中…');
    }
  }
}

function dashboardURL(params, sections = []) {
  const next = new URLSearchParams(params);
  if (sections.length) next.set('sections', sections.join(','));
  return '/api/dashboard?' + next.toString();
}

function emptyDashboard(range = {}) {
  return {
    range,
    summary: {},
    trends: [],
    service_trends: [],
    team_trends: [],
    person_trends: [],
    status_breakdown: [],
    severity_breakdown: [],
    team_breakdown: [],
    service_breakdown: [],
    attention: [],
    my_attention: [],
    team_attention: [],
    notification_health: {},
    report: {},
  };
}

function mergeDashboardSections(base = {}, patch = {}, sections = []) {
  const out = { ...emptyDashboard(base.range), ...base };
  if (patch.range) out.range = patch.range;
  const wants = (section) => sections.includes(section);
  if (wants('summary')) out.summary = patch.summary || {};
  if (wants('trends')) out.trends = patch.trends || [];
  if (wants('breakdowns')) {
    out.status_breakdown = patch.status_breakdown || [];
    out.severity_breakdown = patch.severity_breakdown || [];
    out.team_breakdown = patch.team_breakdown || [];
    out.service_breakdown = patch.service_breakdown || [];
  }
  if (wants('dimension_trends')) {
    out.service_trends = patch.service_trends || [];
    out.team_trends = patch.team_trends || [];
    out.person_trends = patch.person_trends || [];
  }
  if (wants('attention')) {
    out.attention = patch.attention || [];
  }
  if (wants('report')) {
    out.notification_health = patch.notification_health || {};
    out.report = patch.report || {};
    out.my_attention = patch.my_attention || [];
    out.team_attention = patch.team_attention || [];
  }
  return out;
}

function dashboardQueryParams() {
  const params = new URLSearchParams();
  const scope = $('#dashboard-scope')?.value || 'all';
  if (scope && scope !== 'all') params.set('scope', scope);
  const range = $('#dashboard-range')?.value || '7d';
  params.set('range', range);
  [
    ['team', '#dashboard-team'],
    ['service', '#dashboard-service'],
    ['severity', '#dashboard-severity'],
    ['assignee', '#dashboard-assignee'],
    ['env', '#dashboard-env'],
  ].forEach(([key, selector]) => {
    const value = $(selector)?.value;
    if (value) params.set(key, value);
  });
  return params;
}

function resetDashboardFilters() {
  $('#dashboard-scope').value = 'all';
  $('#dashboard-range').value = '7d';
  $('#dashboard-team').value = '';
  $('#dashboard-service').value = '';
  $('#dashboard-severity').value = '';
  $('#dashboard-assignee').value = '';
  $('#dashboard-env').value = '';
  loadDashboard({ force: true, quiet: hasPageData('dashboard') });
}

async function ensureDashboardFilterOptions(force = false) {
  if (!force && state.filterOptions) {
    applyFilterOptions(state.filterOptions);
    return;
  }
  await loadFilterOptions({ quiet: true, force });
}

function renderDashboard(dash) {
  state.dashboard = dash;
  const s = dash.summary || {};
  $('#m-open').textContent = s.open_cases ?? 0;
  $('#m-unacked').textContent = s.unacked_cases ?? 0;
  $('#m-new-cases').textContent = s.new_cases ?? 0;
  $('#m-closed-cases').textContent = s.closed_cases ?? 0;
  $('#m-events').textContent = s.total_events ?? 0;
  $('#m-suppressed-events').textContent = s.suppressed_events ?? 0;
  $('#m-reopened-cases').textContent = s.reopened_cases ?? 0;
  $('#m-ack-sla').textContent = s.unacked_over_sla ?? 0;
  $('#m-resolve-sla').textContent = s.unresolved_over_sla ?? 0;
  $('#m-ack-sla-hint').textContent = `未 ACK 超过 ${s.ack_sla_minutes || 15} 分钟`;
  $('#m-resolve-sla-hint').textContent = `活跃超过 ${formatMinutes(s.resolve_sla_minutes || 240)}`;
  renderDurationMetric('#m-mtta', '#m-mtta-hint', s.mtta_hours, s.acked_cases, '当前范围暂无 ACK 等待样本');
  renderDurationMetric('#m-mttr', '#m-mttr-hint', s.mttr_hours, s.closed_cases, '当前范围暂无已解决或已关闭的 Case');
  $('#dashboard-range-label').textContent = dash.range?.label || '当前范围';
  $('#dashboard-trend-range-label').textContent = dash.range?.label || '当前范围';

  const attention = dash.attention || [];
  renderMiniCaseList('#my-attention', dash.my_attention || [], {
    empty: '当前登录人没有待处理 Case',
    cta: '查看全部活跃 Case',
    page: 'cases',
  });
  renderMiniCaseList('#team-attention', (dash.team_attention || []).length ? dash.team_attention : attention, {
    empty: '当前团队没有待处理 Case',
    cta: '查看全部团队 Case',
    page: 'team',
  });
  renderOpsHealth(dash);
  renderReportPeriod('#report-daily', dash.report?.daily);
  renderReportPeriod('#report-weekly', dash.report?.weekly);
  renderTrendChart(dash.trends || []);
  renderBreakdown('#status-breakdown', dash.status_breakdown || [], { type: 'status' });
  renderBreakdown('#severity-breakdown', dash.severity_breakdown || [], { type: 'severity' });
  renderTeamBreakdown(dash.team_breakdown || []);
  renderServiceBreakdown(dash.service_breakdown || []);
  renderServiceRouteHealth(dash.service_breakdown || []);
  applyDashboardTeamOptions(dash.team_breakdown || []);
  renderAttentionQueue(attention);
}

function formatMinutes(value) {
  const n = Number(value || 0);
  if (n < 60) return `${n} 分钟`;
  if (n % 60 === 0) return `${n / 60} 小时`;
  return `${(n / 60).toFixed(1)} 小时`;
}

function renderMiniCaseList(selector, rows, options = {}) {
  const el = $(selector);
  if (!el) return;
  if (!rows.length) {
    const cta = options.cta && options.page
      ? `<button type="button" class="btn btn-sm btn-link" data-goto-page="${esc(options.page)}">${esc(options.cta)}</button>`
      : '';
    el.innerHTML = `<div class="empty-cell mini-empty">
      <strong>${esc(options.empty || '暂无待处理 Case')}</strong>
      ${cta}
    </div>`;
    $$(`${selector} [data-goto-page]`).forEach((btn) => {
      btn.addEventListener('click', () => showPage(btn.dataset.gotoPage));
    });
    return;
  }
  el.innerHTML = rows.slice(0, 6).map((c) => `
    <button type="button" class="mini-case" data-case="${esc(c.id)}">
      <span>${severityBadge(c.severity)} ${badge(c.status)}</span>
      <strong title="${esc(c.title)}">${esc(short(c.title, 56))}</strong>
      <small>${esc(displayService(c.service, c))} · ${esc(c.assignee || '未指派')} · ${esc(fmtAge(c.last_seen))}</small>
    </button>`).join('');
  $$(`${selector} [data-case]`).forEach((btn) => {
    btn.addEventListener('click', () => gotoCase(btn.dataset.case));
  });
}

function renderOpsHealth(dash) {
  const el = $('#ops-health');
  if (!el) return;
  const s = dash.summary || {};
  const n = dash.notification_health || {};
  const failures = Number(n.failure_count || 0);
  const successes = Number(n.success_count || 0);
  el.innerHTML = `
    <button type="button" class="ops-health-item ${Number(s.unacked_over_sla || 0) ? 'warn' : 'ok'}" data-kpi="ack-sla">
      <span>ACK 超时</span><strong>${s.unacked_over_sla || 0}</strong>
      <small>${formatMinutes(s.ack_sla_minutes || 15)} 未确认</small>
    </button>
    <button type="button" class="ops-health-item ${Number(s.unresolved_over_sla || 0) ? 'warn' : 'ok'}" data-kpi="resolve-sla">
      <span>解决超时</span><strong>${s.unresolved_over_sla || 0}</strong>
      <small>${formatMinutes(s.resolve_sla_minutes || 240)} 未恢复</small>
    </button>
    <button type="button" class="ops-health-item ${failures ? 'warn' : 'ok'}" data-goto-page="diagnostics">
      <span>通知送达</span><strong>${successes}/${successes + failures}</strong>
      <small>${failures ? `${failures} 次失败` : '最近无失败'}</small>
    </button>`;
  $$('#ops-health [data-kpi]').forEach((btn) => {
    btn.addEventListener('click', () => drillDownFromKPI(btn.dataset.kpi));
  });
  $$('#ops-health [data-goto-page]').forEach((btn) => {
    btn.addEventListener('click', () => showPage(btn.dataset.gotoPage));
  });
}

function renderServiceRouteHealth(rows = []) {
  const el = $('#service-route-health');
  if (!el) return;
  const total = rows.length;
  const missingOwner = rows.filter((r) => !String(r.owner || '').trim() || r.owner === '—').length;
  const missingTeam = rows.filter((r) => !String(r.team || '').trim() || r.team === '未配置团队').length;
  const routed = Math.max(0, total - Math.max(missingOwner, missingTeam));
  el.innerHTML = `
    <button type="button" class="route-health-card ok" data-goto-page="owners">
      <span>已路由服务</span><strong>${routed}</strong>
    </button>
    <button type="button" class="route-health-card ${missingOwner ? 'warn' : 'ok'}" data-goto-page="owners">
      <span>缺 Owner</span><strong>${missingOwner}</strong>
    </button>
    <button type="button" class="route-health-card ${missingTeam ? 'warn' : 'ok'}" data-goto-page="owners">
      <span>缺团队</span><strong>${missingTeam}</strong>
    </button>`;
  $$('#service-route-health [data-goto-page]').forEach((btn) => {
    btn.addEventListener('click', () => showPage(btn.dataset.gotoPage));
  });
}

function renderDiagMetric(label, value, hint = '', tone = '') {
  return `<div class="diag-row ${esc(tone)}">
    <span>${esc(label)}</span>
    <strong>${esc(value)}</strong>
    ${hint ? `<small>${esc(hint)}</small>` : ''}
  </div>`;
}

function renderDiagnostics(diag = {}) {
  const webhooks = diag.webhooks || {};
  const enrichment = diag.enrichment || {};
  const notification = diag.notification_health || {};
  $('#diag-webhook').innerHTML = [
    renderDiagMetric('24h 回调', webhooks.total_24h ?? 0, 'CLS / Webhook 收到的请求'),
    renderDiagMetric('已处理', webhooks.processed_24h ?? 0, '已落库或已完成解析'),
    renderDiagMetric('异常', webhooks.failed_24h ?? 0, '超过 5 分钟仍未处理', Number(webhooks.failed_24h || 0) ? 'warn' : 'ok'),
    renderDiagMetric('最近收到', webhooks.last_received ? fmtAge(webhooks.last_received) : '暂无', webhooks.last_received ? fmtTime(webhooks.last_received) : ''),
    renderDiagMetric('最近处理', webhooks.last_processed ? fmtAge(webhooks.last_processed) : '暂无', webhooks.last_processed ? fmtTime(webhooks.last_processed) : ''),
  ].join('');
  $('#diag-enrichment').innerHTML = [
    renderDiagMetric('待补齐', enrichment.pending ?? 0, '等待 CLS 查询业务日志'),
    renderDiagMetric('重试中', enrichment.retry ?? 0, '等待下一次 retry', Number(enrichment.retry || 0) ? 'warn' : 'ok'),
    renderDiagMetric('补齐失败', enrichment.failed ?? 0, '已达到重试上限', Number(enrichment.failed || 0) ? 'warn' : 'ok'),
    renderDiagMetric('仅元数据', enrichment.metadata_only ?? 0, '不能形成业务 Case'),
    renderDiagMetric('已补齐', enrichment.enriched ?? 0, '已拿到业务日志明细'),
  ].join('');
  const success = Number(notification.success_count || 0);
  const failure = Number(notification.failure_count || 0);
  const rate = success + failure > 0 ? `${Math.round((success / (success + failure)) * 100)}%` : '暂无样本';
  $('#diag-notification').innerHTML = [
    renderDiagMetric('成功', success, '通知发送成功'),
    renderDiagMetric('失败', failure, '渠道或配置错误', failure ? 'warn' : 'ok'),
    renderDiagMetric('送达率', rate, '最近 24 小时'),
  ].join('');
  fillTable('#diag-notification-failures tbody', notification.recent_failures || [], (n) => `
    <tr>
      <td title="${esc(fmtTime(n.created_at))}">${esc(fmtAge(n.created_at))}</td>
      <td class="mono">${esc(short(n.case_id || '—', 18))}</td>
      <td>${esc(n.reason || '—')}</td>
      <td>${esc(displayService(n.service))}</td>
      <td>${esc(n.channel_type || 'wecom')}${n.provider ? ` / ${esc(n.provider)}` : ''}</td>
      <td title="${esc(n.error || '')}">${esc(short(n.error || '—', 72))}</td>
    </tr>`, 6);
}

async function loadDiagnostics({ quiet = false, force = false, prefetch = false } = {}) {
  if (!force && state.diagnostics && isFresh('diagnostics')) {
    if (!prefetch) renderDiagnostics(state.diagnostics);
    return;
  }
  if (prefetch && state.diagnostics && !force) return;

  const quietMode = quiet && hasPageData('diagnostics');
  if (quietMode) setRefreshing('diagnostics', true);
  else $('#diagnostics-loading')?.classList.remove('hidden');
  $('#diagnostics-error')?.classList.add('hidden');
  if (!quietMode && !prefetch) $('#diagnostics-content')?.classList.add('hidden');
  setButtonBusy($('#diagnostics-refresh'), true, '刷新中…', '刷新诊断');
  try {
    const data = await runOnce('diagnostics', () => api('/api/diagnostics'));
    state.diagnostics = data || {};
    $('#diagnostics-loading')?.classList.add('hidden');
    if (!prefetch) {
      renderDiagnostics(state.diagnostics);
      $('#diagnostics-content')?.classList.remove('hidden');
    }
    markRefresh('diagnostics');
  } catch (e) {
    $('#diagnostics-loading')?.classList.add('hidden');
    if (!prefetch) {
      $('#diagnostics-error').textContent = e.message;
      $('#diagnostics-error').classList.remove('hidden');
    }
  } finally {
    setRefreshing('diagnostics', false);
    setButtonBusy($('#diagnostics-refresh'), false, '刷新中…', '刷新诊断');
  }
}

function renderReportPeriod(selector, report = {}) {
  const el = $(selector);
  if (!el) return;
  const cells = [
    ['新增', report.new_cases ?? 0],
    ['关闭', report.closed_cases ?? 0],
    ['活跃', report.active_cases ?? 0],
    ['事件', report.events ?? 0],
    ['抑制', report.suppressed_events ?? 0],
    ['复发', report.reopened_cases ?? 0],
    ['ACK均时', formatHours(report.mtta_hours)],
    ['解决均时', formatHours(report.mttr_hours)],
  ];
  el.innerHTML = cells.map(([label, value]) => `
    <div class="report-cell"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('');
}

function renderDurationMetric(valueSelector, hintSelector, value, sampleCount, emptyText) {
  const valueEl = $(valueSelector);
  const hintEl = $(hintSelector);
  if (!valueEl) return;
  const count = Number(sampleCount || 0);
  if (value == null || Number.isNaN(Number(value))) {
    valueEl.textContent = '暂无样本';
    valueEl.classList.add('value-empty');
    if (hintEl) hintEl.textContent = emptyText;
    return;
  }
  valueEl.textContent = formatHours(value);
  valueEl.classList.remove('value-empty');
  if (hintEl) hintEl.textContent = `基于 ${count} 个样本`;
}

function formatHours(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  if (n < 1) return `${Math.round(n * 60)}m`;
  return `${n.toFixed(1)}h`;
}

function formatCount(value) {
  const n = Number(value || 0);
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function renderTrendChart(points) {
  const el = $('#dashboard-trend');
  if (!el) return;
  renderTrendModeButtons();
  if (isDimensionTrendMode(state.dashboardTrendMode)) {
    renderServiceTrendChart(dashboardDimensionSeries(state.dashboardTrendMode));
    return;
  }
  renderServiceTrendToolbar([]);
  renderTrendInsights(points || []);
  if (!points.length) {
    el.innerHTML = '<div class="empty-state compact">暂无趋势数据</div>';
    return;
  }
  const mode = trendModeConfig(state.dashboardTrendMode);
  const width = 960;
  const height = 300;
  const pad = { left: 48, right: 46, top: 22, bottom: 42 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const barSeries = mode.series.filter((s) => s.type === 'bar');
  const lineSeries = mode.series.filter((s) => s.type !== 'bar');
  const maxBars = Math.max(1, ...points.flatMap((p) => barSeries.map((s) => trendValue(p, s.key))));
  const maxLines = Math.max(1, ...points.flatMap((p) => lineSeries.map((s) => trendValue(p, s.key))));
  const step = plotW / Math.max(1, points.length);
  const groupW = Math.max(8, Math.min(36, step * 0.66));
  const barW = Math.max(4, (groupW / Math.max(1, barSeries.length)) - 2);
  const xFor = (i) => pad.left + i * step + step / 2;
  const barY = (v) => pad.top + plotH - (Number(v || 0) / maxBars) * plotH;
  const lineY = (v) => pad.top + plotH - (Number(v || 0) / maxLines) * plotH;
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));
  const bars = points.flatMap((p, i) => barSeries.map((s, j) => {
    const x = xFor(i) - groupW / 2 + j * (barW + 2);
    const value = trendValue(p, s.key);
    const y = barY(value);
    const h = pad.top + plotH - y;
    return `<rect class="trend-bar trend-bar-${esc(s.key)}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}">
      <title>${esc(p.label)} ${esc(s.label)} ${formatTrendValue(value, s)}</title>
    </rect>`;
  })).join('');
  const lines = lineSeries.map((s) => {
    const line = points.map((p, i) => `${xFor(i).toFixed(1)},${lineY(trendValue(p, s.key)).toFixed(1)}`).join(' ');
    const titles = points.map((p) => `${p.label} ${s.label} ${formatTrendValue(trendValue(p, s.key), s)}`).join(' / ');
    return `<polyline class="trend-line trend-line-${esc(s.key)}" points="${line}" fill="none"><title>${esc(titles)}</title></polyline>`;
  }).join('');
  const hoverLayer = renderTrendHoverLayer({
    points,
    width,
    pad,
    plotH,
    zoneW: step,
    xFor,
    tooltipW: 176,
    rowsForPoint: (p) => mode.series.map((s) => ({
      label: s.label,
      value: formatTrendValue(trendValue(p, s.key), s),
      className: `trend-tooltip-dot-${s.key}`,
    })),
  });
  const labels = points.map((p, i) => {
    if (i % labelEvery !== 0 && i !== points.length - 1) return '';
    return `<text class="trend-label" x="${xFor(i).toFixed(1)}" y="${height - 12}" text-anchor="middle">${esc(p.label)}</text>`;
  }).join('');
  const legend = $('#dashboard-trend-legend');
  if (legend) {
    legend.innerHTML = mode.series.map((s) => `<span><i class="legend-dot legend-${esc(s.key)}"></i>${esc(s.label)}</span>`).join('');
  }
  el.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="告警趋势">
      <line class="trend-grid" x1="${pad.left}" y1="${pad.top + plotH * 0.5}" x2="${width - pad.right}" y2="${pad.top + plotH * 0.5}"></line>
      <line class="trend-axis" x1="${pad.left}" y1="${pad.top + plotH}" x2="${width - pad.right}" y2="${pad.top + plotH}"></line>
      <line class="trend-axis" x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}"></line>
      <line class="trend-axis trend-axis-right" x1="${width - pad.right}" y1="${pad.top}" x2="${width - pad.right}" y2="${pad.top + plotH}"></line>
      <text class="trend-scale" x="6" y="${pad.top + 8}">${formatCount(maxBars)}</text>
      <text class="trend-scale trend-scale-right" x="${width - 4}" y="${pad.top + 8}" text-anchor="end">${formatTrendScale(maxLines, mode.lineUnit)}</text>
      <text class="trend-scale" x="6" y="${pad.top + plotH}">0</text>
      ${bars}
      ${lines}
      ${hoverLayer}
      ${labels}
    </svg>`;
}

function renderServiceTrendChart(series) {
  const el = $('#dashboard-trend');
  if (!el) return;
  const dimension = dashboardDimensionConfig(state.dashboardTrendMode);
  syncServiceTrendSelection(series || []);
  renderServiceTrendInsights(series || []);
  renderServiceTrendToolbar(series || []);
  if (!series.length) {
    el.innerHTML = `<div class="empty-state compact">当前范围暂无${esc(dimension.label)}趋势数据</div>`;
    const legend = $('#dashboard-trend-legend');
    if (legend) legend.innerHTML = '';
    return;
  }
  const selected = series.filter((s) => state.dashboardServiceTrendSelection.has(serviceTrendKey(s)));
  if (!selected.length) {
    el.innerHTML = `<div class="empty-state compact">选择${esc(dimension.label)}后显示曲线</div>`;
    const legend = $('#dashboard-trend-legend');
    if (legend) legend.innerHTML = `<span>点击下方${esc(dimension.label)}名称打开曲线</span>`;
    return;
  }

  const metric = serviceTrendMetricConfig(state.dashboardServiceTrendMetric);
  const points = selected[0]?.points || [];
  const width = 960;
  const height = 300;
  const pad = { left: 48, right: 28, top: 22, bottom: 42 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const maxValue = Math.max(1, ...selected.flatMap((s) => (s.points || []).map((p) => serviceTrendValue(p, metric.key))));
  const step = plotW / Math.max(1, points.length - 1 || 1);
  const xFor = (i) => pad.left + (points.length <= 1 ? plotW / 2 : i * step);
  const yFor = (v) => pad.top + plotH - (Number(v || 0) / maxValue) * plotH;
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));
  const lines = selected.map((s, seriesIndex) => {
    const originalIndex = series.findIndex((item) => serviceTrendKey(item) === serviceTrendKey(s));
    const color = serviceTrendColor(originalIndex >= 0 ? originalIndex : seriesIndex);
    const coords = (s.points || []).map((p, i) => `${xFor(i).toFixed(1)},${yFor(serviceTrendValue(p, metric.key)).toFixed(1)}`).join(' ');
    const dots = (s.points || []).map((p, i) => {
      const value = serviceTrendValue(p, metric.key);
      return `<circle class="service-trend-dot" cx="${xFor(i).toFixed(1)}" cy="${yFor(value).toFixed(1)}" r="3.2" style="fill:${color}">
        <title>${esc(dimensionTrendLabel(s))} · ${esc(p.label)} · ${esc(metric.label)} ${formatTrendValue(value, metric)}</title>
      </circle>`;
    }).join('');
    const titles = (s.points || []).map((p) => `${p.label} ${metric.label} ${formatTrendValue(serviceTrendValue(p, metric.key), metric)}`).join(' / ');
    return `<g class="service-trend-series">
      <polyline class="trend-line service-trend-line" points="${coords}" fill="none" style="stroke:${color}"><title>${esc(dimensionTrendLabel(s))}: ${esc(titles)}</title></polyline>
      ${dots}
    </g>`;
  }).join('');
  const hoverLayer = renderTrendHoverLayer({
    points,
    width,
    pad,
    plotH,
    zoneW: Math.max(36, step),
    xFor,
    tooltipW: 236,
    maxRows: 12,
    titleSuffix: metric.label,
    rowsForPoint: (_p, pointIndex) => selected.map((s, seriesIndex) => {
      const originalIndex = series.findIndex((item) => serviceTrendKey(item) === serviceTrendKey(s));
      const color = serviceTrendColor(originalIndex >= 0 ? originalIndex : seriesIndex);
      const point = (s.points || [])[pointIndex] || {};
      return {
        label: dimensionTrendLabel(s),
        value: formatTrendValue(serviceTrendValue(point, metric.key), metric),
        color,
      };
    }),
  });
  const labels = points.map((p, i) => {
    if (i % labelEvery !== 0 && i !== points.length - 1) return '';
    return `<text class="trend-label" x="${xFor(i).toFixed(1)}" y="${height - 12}" text-anchor="middle">${esc(p.label)}</text>`;
  }).join('');
  const legend = $('#dashboard-trend-legend');
  if (legend) {
    legend.innerHTML = `<span>${esc(metric.label)} · ${selected.length}/${series.length} 条${esc(dimension.label)}曲线</span>`;
  }
  el.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(dimension.label)}趋势">
      <line class="trend-grid" x1="${pad.left}" y1="${pad.top + plotH * 0.5}" x2="${width - pad.right}" y2="${pad.top + plotH * 0.5}"></line>
      <line class="trend-axis" x1="${pad.left}" y1="${pad.top + plotH}" x2="${width - pad.right}" y2="${pad.top + plotH}"></line>
      <line class="trend-axis" x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}"></line>
      <text class="trend-scale" x="6" y="${pad.top + 8}">${formatTrendScale(maxValue, metric.unit)}</text>
      <text class="trend-scale" x="6" y="${pad.top + plotH}">0</text>
      ${lines}
      ${hoverLayer}
      ${labels}
    </svg>`;
}

function renderTrendHoverLayer({
  points,
  width,
  pad,
  plotH,
  zoneW,
  xFor,
  rowsForPoint,
  tooltipW = 190,
  maxRows = 10,
  titleSuffix = '',
}) {
  if (!Array.isArray(points) || !points.length || typeof rowsForPoint !== 'function') return '';
  const plotTop = pad.top;
  const plotBottom = pad.top + plotH;
  return `<g class="trend-hover-layer">
    ${points.map((p, i) => {
      const x = xFor(i);
      const rawRows = rowsForPoint(p, i).filter(Boolean);
      const rows = rawRows.slice(0, maxRows);
      const hiddenCount = Math.max(0, rawRows.length - rows.length);
      const tooltipH = 34 + rows.length * 16 + (hiddenCount ? 16 : 0);
      const tooltipX = x > width - pad.right - tooltipW - 12 ? x - tooltipW - 10 : x + 10;
      const tooltipY = Math.max(8, Math.min(plotTop + 8, plotBottom - tooltipH - 8));
      return `<g class="trend-hover-point">
        <rect class="trend-hover-zone" x="${(x - zoneW / 2).toFixed(1)}" y="${plotTop}" width="${zoneW.toFixed(1)}" height="${plotH}"></rect>
        <line class="trend-hover-line" x1="${x.toFixed(1)}" y1="${plotTop}" x2="${x.toFixed(1)}" y2="${plotBottom}"></line>
        <g class="trend-tooltip" transform="translate(${tooltipX.toFixed(1)} ${tooltipY.toFixed(1)})">
          <rect class="trend-tooltip-bg" width="${tooltipW}" height="${tooltipH}" rx="8"></rect>
          <text class="trend-tooltip-title" x="12" y="18">${esc(p.label || '—')}${titleSuffix ? ` · ${esc(titleSuffix)}` : ''}</text>
          ${rows.map((row, rowIndex) => {
            const y = 39 + rowIndex * 16;
            const dot = row.color
              ? `<circle class="trend-tooltip-dot" cx="14" cy="${y - 4}" r="3.6" style="fill:${esc(row.color)}"></circle>`
              : `<circle class="trend-tooltip-dot ${esc(row.className || '')}" cx="14" cy="${y - 4}" r="3.6"></circle>`;
            return `${dot}
              <text class="trend-tooltip-label" x="24" y="${y}">${esc(short(row.label || '—', 18))}</text>
              <text class="trend-tooltip-value" x="${tooltipW - 12}" y="${y}" text-anchor="end">${esc(row.value ?? '—')}</text>`;
          }).join('')}
          ${hiddenCount ? `<text class="trend-tooltip-more" x="12" y="${39 + rows.length * 16}">另 ${hiddenCount} 条曲线</text>` : ''}
        </g>
      </g>`;
    }).join('')}
  </g>`;
}

function syncServiceTrendSelection(series) {
  const signature = `${state.dashboardTrendMode}:${series.map((s) => serviceTrendKey(s)).join('|')}`;
  if (signature !== state.dashboardServiceTrendSignature) {
    state.dashboardServiceTrendSignature = signature;
    state.dashboardServiceTrendSelection = new Set(series.slice(0, 5).map((s) => serviceTrendKey(s)));
    return;
  }
  const valid = new Set(series.map((s) => serviceTrendKey(s)));
  state.dashboardServiceTrendSelection = new Set([...state.dashboardServiceTrendSelection].filter((key) => valid.has(key)));
}

function renderServiceTrendToolbar(series) {
  const el = $('#dashboard-service-trend-toolbar');
  if (!el) return;
  if (!isDimensionTrendMode(state.dashboardTrendMode)) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');
  const metric = serviceTrendMetricConfig(state.dashboardServiceTrendMetric);
  const dimension = dashboardDimensionConfig(state.dashboardTrendMode);
  const selectedCount = series.filter((s) => state.dashboardServiceTrendSelection.has(serviceTrendKey(s))).length;
  el.innerHTML = `
    <div class="service-trend-toolbar-row">
      <div class="segmented-control compact" id="dashboard-service-trend-metric" role="tablist" aria-label="${esc(dimension.label)}趋势指标">
        ${serviceTrendMetricOptions().map((m) => `<button type="button" class="${m.key === metric.key ? 'active' : ''}" data-service-trend-metric="${esc(m.key)}">${esc(m.label)}</button>`).join('')}
      </div>
      <div class="service-trend-actions">
        <span>${selectedCount}/${series.length} 条${esc(dimension.label)}曲线</span>
        <button type="button" class="btn btn-xs btn-link" data-service-trend-select="top">Top 5</button>
        <button type="button" class="btn btn-xs btn-link" data-service-trend-select="all">全选</button>
        <button type="button" class="btn btn-xs btn-link" data-service-trend-select="none">清空</button>
      </div>
    </div>
    <div class="service-trend-chips">
      ${series.map((s, i) => {
        const key = serviceTrendKey(s);
        const active = state.dashboardServiceTrendSelection.has(key);
        return `<button type="button" class="service-trend-chip ${active ? 'active' : ''}" data-service-trend-toggle="${esc(key)}" title="${esc(serviceTrendTitle(s))}">
          <i style="background:${serviceTrendColor(i)}"></i>
          <span>${esc(short(dimensionTrendLabel(s), 24))}</span>
          <small>${formatTrendValue(serviceTrendTotalForMetric(s, metric.key), metric)}</small>
        </button>`;
      }).join('')}
    </div>`;
  $$('#dashboard-service-trend-metric [data-service-trend-metric]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.dashboardServiceTrendMetric = btn.dataset.serviceTrendMetric || 'events';
      renderTrendChart(state.dashboard?.trends || []);
    });
  });
  $$('#dashboard-service-trend-toolbar [data-service-trend-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.serviceTrendToggle;
      if (state.dashboardServiceTrendSelection.has(key)) state.dashboardServiceTrendSelection.delete(key);
      else state.dashboardServiceTrendSelection.add(key);
      renderTrendChart(state.dashboard?.trends || []);
    });
  });
  $$('#dashboard-service-trend-toolbar [data-service-trend-select]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.serviceTrendSelect;
      if (action === 'all') state.dashboardServiceTrendSelection = new Set(series.map((s) => serviceTrendKey(s)));
      if (action === 'top') state.dashboardServiceTrendSelection = new Set(series.slice(0, 5).map((s) => serviceTrendKey(s)));
      if (action === 'none') state.dashboardServiceTrendSelection = new Set();
      renderTrendChart(state.dashboard?.trends || []);
    });
  });
}

function renderServiceTrendInsights(series) {
  const el = $('#dashboard-trend-insights');
  if (!el) return;
  if (!series.length) {
    el.innerHTML = '';
    return;
  }
  const metric = serviceTrendMetricConfig(state.dashboardServiceTrendMetric);
  const dimension = dashboardDimensionConfig(state.dashboardTrendMode);
  const top = [...series].sort((a, b) => serviceTrendTotalForMetric(b, metric.key) - serviceTrendTotalForMetric(a, metric.key))[0] || {};
  const selected = series.filter((s) => state.dashboardServiceTrendSelection.has(serviceTrendKey(s)));
  const selectedTotal = selected.reduce((sum, s) => sum + serviceTrendTotalForMetric(s, metric.key), 0);
  const total = series.reduce((sum, s) => sum + serviceTrendTotalForMetric(s, metric.key), 0);
  const noiseLeader = [...series].sort((a, b) => Number(b.suppressed_events || 0) - Number(a.suppressed_events || 0))[0] || {};
  const slowAck = [...series].sort((a, b) => Number(b.mtta_hours || 0) - Number(a.mtta_hours || 0))[0] || {};
  const coverage = total ? `${Math.round((selectedTotal / total) * 100)}%` : '0%';
  el.innerHTML = `
    <div class="trend-insight"><span>Top ${esc(dimension.label)}</span><strong title="${esc(dimensionTrendLabel(top))}">${esc(dimensionTrendLabel(top))}</strong><small>${esc(metric.label)} ${formatTrendValue(serviceTrendTotalForMetric(top, metric.key), metric)}</small></div>
    <div class="trend-insight"><span>已选曲线</span><strong>${selected.length}</strong><small>覆盖 ${coverage}</small></div>
    <div class="trend-insight ${Number(slowAck.mtta_hours || 0) ? 'warn' : 'ok'}"><span>ACK 最慢</span><strong title="${esc(dimensionTrendLabel(slowAck))}">${esc(dimensionTrendLabel(slowAck))}</strong><small>${formatHours(slowAck.mtta_hours)} 含未 ACK 等待</small></div>
    <div class="trend-insight ${Number(noiseLeader.suppressed_events || 0) ? 'warn' : 'ok'}"><span>噪声最高</span><strong title="${esc(dimensionTrendLabel(noiseLeader))}">${esc(dimensionTrendLabel(noiseLeader))}</strong><small>${formatCount(noiseLeader.suppressed_events || 0)} 条抑制</small></div>`;
}

function serviceTrendMetricOptions() {
  return [
    { key: 'events', label: '事件', unit: 'count' },
    { key: 'new_cases', label: '新增 Case', unit: 'count' },
    { key: 'active_cases', label: '活跃 Case', unit: 'count' },
    { key: 'unacked_cases', label: '待 ACK', unit: 'count' },
    { key: 'ack_over_sla_cases', label: 'ACK 超时', unit: 'count' },
    { key: 'mtta_hours', label: '平均 ACK', unit: 'duration' },
    { key: 'mttr_hours', label: '平均解决', unit: 'duration' },
    { key: 'reopened_cases', label: '复发', unit: 'count' },
    { key: 'closed_cases', label: '关闭 Case', unit: 'count' },
    { key: 'suppressed_events', label: '噪声', unit: 'count' },
    { key: 'suppressed_rate', label: '噪声占比', unit: 'percent' },
  ];
}

function serviceTrendMetricConfig(key) {
  return serviceTrendMetricOptions().find((m) => m.key === key) || serviceTrendMetricOptions()[0];
}

function isDimensionTrendMode(mode) {
  return mode === 'service' || mode === 'team' || mode === 'person';
}

function dashboardDimensionConfig(mode) {
  if (mode === 'team') return { key: 'team_trends', label: '团队' };
  if (mode === 'person') return { key: 'person_trends', label: '人员' };
  return { key: 'service_trends', label: '服务' };
}

function dashboardDimensionSeries(mode) {
  const config = dashboardDimensionConfig(mode);
  return state.dashboard?.[config.key] || [];
}

function dimensionTrendLabel(series = {}) {
  const raw = series.label || series.service || series.team || series.owner || series.key || '—';
  if (raw === '—') return '未指派';
  if (series.kind === 'service' || (!series.kind && series.service)) return displayService(raw);
  return raw;
}

function serviceTrendKey(series) {
  return String(series?.key || series?.service || series?.label || 'unknown');
}

function serviceTrendValue(point, key) {
  if (key === 'suppressed_rate') {
    const events = Number(point?.events || 0);
    if (!events) return 0;
    return Math.round((Number(point?.suppressed_events || 0) / events) * 100);
  }
  return Number(point?.[key] || 0);
}

function serviceTrendTotalForMetric(series, key) {
  if (key === 'suppressed_rate') {
    const events = Number(series?.events || 0);
    if (!events) return 0;
    return Math.round((Number(series?.suppressed_events || 0) / events) * 100);
  }
  if (key === 'events') return Number(series?.events || 0);
  if (key === 'new_cases') return Number(series?.new_cases || 0);
  if (key === 'active_cases') return Number(series?.active_cases || 0);
  if (key === 'unacked_cases') return Number(series?.unacked_cases || 0);
  if (key === 'ack_over_sla_cases') return Number(series?.ack_over_sla_cases || 0);
  if (key === 'mtta_hours') return series?.mtta_hours ?? null;
  if (key === 'mttr_hours') return series?.mttr_hours ?? null;
  if (key === 'reopened_cases') return Number(series?.reopened_cases || 0);
  if (key === 'closed_cases') return Number(series?.closed_cases || 0);
  if (key === 'suppressed_events') return Number(series?.suppressed_events || 0);
  return 0;
}

function serviceTrendTitle(series) {
  const owner = series.owner && series.owner !== '—' ? series.owner : '未指派';
  return `${dimensionTrendLabel(series)} · ${series.team || '未配置团队'} · ${owner} · ${formatCount(series.events || 0)} 事件`;
}

function serviceTrendColor(index) {
  const colors = ['#5a8dee', '#2f9e74', '#d9a441', '#9d7eea', '#67b7dc', '#e0956c', '#e06c6c', '#8fb36a'];
  return colors[index % colors.length];
}

function trendModeConfig(mode) {
  switch (mode) {
    case 'backlog':
      return {
        lineUnit: 'count',
        series: [
          { key: 'active_cases', label: '活跃 Case', type: 'bar' },
          { key: 'unacked_cases', label: '待 ACK', type: 'line' },
          { key: 'acked_cases', label: '已 ACK', type: 'line' },
          { key: 'closed_cases', label: '关闭 Case', type: 'line' },
        ],
      };
    case 'noise':
      return {
        lineUnit: 'percent',
        series: [
          { key: 'events', label: '事件', type: 'bar' },
          { key: 'suppressed_events', label: '抑制事件', type: 'bar' },
          { key: 'suppressed_rate', label: '抑制率', type: 'line', unit: 'percent' },
        ],
      };
    default:
      return {
        lineUnit: 'count',
        series: [
          { key: 'events', label: '事件', type: 'bar' },
          { key: 'new_cases', label: '新增 Case', type: 'line' },
          { key: 'closed_cases', label: '关闭 Case', type: 'line' },
          { key: 'reopened_cases', label: '复发 Case', type: 'line' },
        ],
      };
  }
}

function trendValue(point, key) {
  if (key === 'suppressed_rate') {
    const events = Number(point.events || 0);
    if (!events) return 0;
    return Math.round((Number(point.suppressed_events || 0) / events) * 100);
  }
  return Number(point[key] || 0);
}

function formatTrendValue(value, series = {}) {
  if (series.unit === 'percent') return `${Number(value || 0).toFixed(0)}%`;
  if (series.unit === 'duration') return formatHours(value);
  return formatCount(value);
}

function formatTrendScale(value, unit) {
  if (unit === 'percent') return `${Number(value || 0).toFixed(0)}%`;
  if (unit === 'duration') return formatHours(value);
  return formatCount(value);
}

function renderTrendModeButtons() {
  $$('#dashboard-trend-mode [data-trend-mode]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.trendMode === state.dashboardTrendMode);
    btn.setAttribute('aria-selected', btn.dataset.trendMode === state.dashboardTrendMode ? 'true' : 'false');
  });
}

function renderTrendInsights(points) {
  const el = $('#dashboard-trend-insights');
  if (!el) return;
  if (!points.length) {
    el.innerHTML = '';
    return;
  }
  const totalEvents = points.reduce((sum, p) => sum + Number(p.events || 0), 0);
  const totalSuppressed = points.reduce((sum, p) => sum + Number(p.suppressed_events || 0), 0);
  const totalNew = points.reduce((sum, p) => sum + Number(p.new_cases || 0), 0);
  const totalClosed = points.reduce((sum, p) => sum + Number(p.closed_cases || 0), 0);
  const last = points[points.length - 1] || {};
  const peak = points.reduce((best, p) => Number(p.events || 0) > Number(best.events || 0) ? p : best, points[0]);
  const noiseRate = totalEvents ? `${Math.round((totalSuppressed / totalEvents) * 100)}%` : '0%';
  const net = totalNew - totalClosed;
  el.innerHTML = `
    <div class="trend-insight"><span>峰值</span><strong>${esc(peak.label || '—')}</strong><small>${formatCount(peak.events || 0)} 事件</small></div>
    <div class="trend-insight ${net > 0 ? 'warn' : 'ok'}"><span>Case 净增</span><strong>${net >= 0 ? '+' : ''}${formatCount(net)}</strong><small>新增 ${formatCount(totalNew)} / 关闭 ${formatCount(totalClosed)}</small></div>
    <div class="trend-insight"><span>当前积压</span><strong>${formatCount(last.active_cases || 0)}</strong><small>${formatCount(last.unacked_cases || 0)} 待 ACK</small></div>
    <div class="trend-insight ${totalSuppressed ? 'warn' : 'ok'}"><span>噪声占比</span><strong>${noiseRate}</strong><small>${formatCount(totalSuppressed)} 条被抑制</small></div>`;
}

function renderBreakdown(selector, rows, { type } = {}) {
  const el = $(selector);
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = '<div class="empty-cell">暂无数据</div>';
    return;
  }
  const max = Math.max(1, ...rows.map((r) => r.count || 0));
  el.innerHTML = rows.map((r) => {
    const pct = Math.max(4, Math.round((Number(r.count || 0) / max) * 100));
    const label = type === 'severity' ? String(r.name || '—').toUpperCase() : (r.name || '—');
    return `<div class="bar-row">
      <span class="bar-label">${esc(label)}</span>
      <span class="bar-track"><i class="bar-fill bar-fill-${esc(String(r.name || '').toLowerCase())}" style="width:${pct}%"></i></span>
      <strong>${r.count || 0}</strong>
    </div>`;
  }).join('');
}

function renderTeamBreakdown(rows) {
  fillTable('#team-breakdown tbody', rows.slice(0, 12), (r) => `
    <tr class="dashboard-row" data-dashboard-team="${esc(r.team || '')}">
      <td>${esc(r.team || '未配置团队')}</td>
      <td>${r.open_cases || 0}<span class="subtle"> / ${r.unacked_cases || 0} 待 ACK</span></td>
      <td>${r.new_cases || 0}</td>
      <td>${r.closed_cases || 0}</td>
      <td>${r.events || 0}<span class="subtle"> / ${r.suppressed_events || 0} 抑制</span></td>
      <td>${formatHours(r.mtta_hours)}</td>
      <td>${formatHours(r.mttr_hours)}</td>
    </tr>`, 7);
  $$('#team-breakdown [data-dashboard-team]').forEach((tr) => {
    tr.addEventListener('click', () => {
      const label = tr.dataset.dashboardTeam;
      const team = state.teams.find((t) => !t.merged_into_team_id && (t.name === label || t.display_name === label));
      setSelectOptionValue('#dashboard-team', team?.id || label, label || '未配置团队');
      loadDashboard();
    });
  });
}

function renderServiceBreakdown(rows) {
  fillTable('#service-breakdown tbody', rows.slice(0, 16), (r) => `
    <tr class="dashboard-row" data-dashboard-service="${esc(r.service || '')}">
      <td title="${esc(r.service || '')}">${esc(short(r.service || '—', 28))}</td>
      <td>${esc(r.team || '未配置团队')}</td>
      <td>${esc(r.owner || '—')}</td>
      <td>${r.open_cases || 0}<span class="subtle"> / ${r.unacked_cases || 0} 待 ACK</span></td>
      <td>${r.events || 0}</td>
      <td>${formatHours(r.mtta_hours)}</td>
    </tr>`, 6);
  $$('#service-breakdown [data-dashboard-service]').forEach((tr) => {
    tr.addEventListener('click', () => {
      const service = tr.dataset.dashboardService;
      if (service) filterCasesByService(service);
    });
  });
}

function applyDashboardTeamOptions() {
  const select = $('#dashboard-team');
  populateTeamSelect(select, { selectedID: select?.value || '', emptyLabel: '全部团队' });
}

function gotoCase(id) {
  showPage('cases');
  openCase(id);
}

function filterCasesByService(service) {
  clearCaseFilters({ reload: false });
  setSelectOptionValue('#case-service', service, displayService(service));
  showPage('cases', { preserveCaseFilters: true });
}

function filterCasesByPattern(fingerprint) {
  clearCaseFilters({ reload: false });
  $('#case-q').value = fingerprint;
  showPage('cases', { preserveCaseFilters: true });
}

function setSelectOptionValue(selector, value, label = value) {
  const el = $(selector);
  if (!el) return;
  if (!el.options) {
    el.value = value;
    return;
  }
  const exists = Array.from(el.options).some((option) => option.value === value);
  if (!exists && value) {
    el.add(new Option(label, value));
  }
  el.value = value;
}

function populateFilterSelect(el, values, { formatLabel = (v) => v, allLabel = '全部' } = {}) {
  if (!el?.options) return;
  const current = el.value;
  const unique = [...new Set((values || []).filter(Boolean))];
  el.innerHTML = `<option value="">${esc(allLabel)}</option>` +
    unique.map((value) => `<option value="${esc(value)}">${esc(formatLabel(value))}</option>`).join('');
  if (current) {
    setSelectOptionValue(`#${el.id}`, current, formatLabel(current));
  } else {
    el.value = '';
  }
}

function applyFilterOptions(data) {
  state.filterOptions = data || FALLBACK_FILTER_OPTIONS;
  const caseOptions = data?.case || {};
  populateFilterSelect(
    $('#case-status'),
    caseOptions.statuses?.length ? caseOptions.statuses : FALLBACK_FILTER_OPTIONS.case.statuses,
    { allLabel: '全部状态' },
  );
  populateFilterSelect(
    $('#case-service'),
    caseOptions.services || [],
    { formatLabel: (value) => displayService(value), allLabel: '全部服务' },
  );
  populateFilterSelect(
    $('#case-severity'),
    caseOptions.severities?.length ? caseOptions.severities : FALLBACK_FILTER_OPTIONS.case.severities,
    { allLabel: '全部严重度' },
  );
  populateFilterSelect($('#case-assignee'), caseOptions.assignees || [], { allLabel: '全部负责人' });
  populateFilterSelect($('#case-env'), caseOptions.environments || [], { allLabel: '全部环境' });

  populateFilterSelect(
    $('#dashboard-service'),
    caseOptions.services || [],
    { formatLabel: (value) => displayService(value), allLabel: '全部服务' },
  );
  populateFilterSelect(
    $('#dashboard-severity'),
    caseOptions.severities?.length ? caseOptions.severities : FALLBACK_FILTER_OPTIONS.case.severities,
    { allLabel: '全部严重度' },
  );
  populateFilterSelect($('#dashboard-assignee'), caseOptions.assignees || [], { allLabel: '全部负责人' });
  populateFilterSelect($('#dashboard-env'), caseOptions.environments || [], { allLabel: '全部环境' });

  const eventOptions = data?.event || {};
  populateFilterSelect(
    $('#event-service'),
    eventOptions.services?.length ? eventOptions.services : (caseOptions.services || []),
    { formatLabel: (value) => displayService(value), allLabel: '全部服务' },
  );
  populateFilterSelect(
    $('#event-env'),
    eventOptions.environments?.length ? eventOptions.environments : (caseOptions.environments || []),
    { allLabel: '全部环境' },
  );
}

async function loadFilterOptions({ quiet = false, force = false } = {}) {
  if (!force && state.filterOptions && isFresh('filter-options', FILTER_OPTIONS_FRESH_MS)) {
    applyFilterOptions(state.filterOptions);
    return state.filterOptions;
  }
  try {
    const data = await runOnce('filter-options', () => api('/api/filter-options'));
    markRefresh('filter-options');
    applyFilterOptions(data);
    return state.filterOptions;
  } catch (err) {
    applyFilterOptions(FALLBACK_FILTER_OPTIONS);
    if (!quiet) toast(`筛选选项加载失败：${err.message}`);
    return state.filterOptions;
  }
}

function renderHotspotRow(row, kind) {
  const label = kind === 'service' ? (row.label || displayService(row.name)) : (row.label || row.name);
  const hint = row.hint ? `<div class="hotspot-hint">${esc(row.hint)}</div>` : '';
  const filter = esc(row.filter || row.name);
  return `<tr class="hotspot-row" data-kind="${kind}" data-filter="${filter}" tabindex="0">
    <td>
      <div class="hotspot-label" title="${esc(label)}">${esc(short(label, 72))}</div>
      ${hint}
    </td>
    <td class="hotspot-count">${row.count}</td>
  </tr>`;
}

function bindHotspotRows(selector, kind) {
  $$(`${selector} .hotspot-row`).forEach((tr) => {
    tr.addEventListener('click', () => {
      const value = tr.dataset.filter || '';
      if (!value) return;
      if (kind === 'service') filterCasesByService(value);
      else filterCasesByPattern(value);
    });
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        tr.click();
      }
    });
  });
}

function clearCaseFilters({ reload = true } = {}) {
  state.caseRiskFilter = '';
  $('#case-view').value = 'active';
  $('#case-scope').value = 'all';
  $('#case-q').value = '';
  $('#case-status').value = '';
  $('#case-service').value = '';
  $('#case-severity').value = '';
  $('#case-assignee').value = '';
  $('#case-env').value = '';
  applyTimeRangePreset('case', '', { reload: false });
  if (reload) loadCases({ force: true, quiet: hasPageData('cases') });
}

function applyQuickFilter(kind, { reload = true } = {}) {
  state.caseRiskFilter = '';
  if (kind === 'open') {
    $('#case-view').value = 'active';
    $('#case-scope').value = 'all';
    $('#case-q').value = '';
    $('#case-status').value = 'open';
    $('#case-service').value = '';
    $('#case-severity').value = '';
    $('#case-assignee').value = '';
    $('#case-env').value = '';
  } else if (kind === 'unacked') {
    $('#case-view').value = 'active';
    $('#case-scope').value = 'all';
    $('#case-q').value = '';
    $('#case-status').value = 'open';
    $('#case-service').value = '';
    $('#case-severity').value = '';
    $('#case-assignee').value = '';
    $('#case-env').value = '';
  } else if (kind === 'mine') {
    $('#case-view').value = 'active';
    $('#case-scope').value = 'mine';
    $('#case-status').value = '';
  } else if (kind === 'critical') {
    $('#case-view').value = 'active';
    $('#case-scope').value = 'all';
    $('#case-severity').value = 'critical';
  }
  if (reload) loadCases({ force: true, quiet: hasPageData('cases') });
}

function drillDownFromKPI(kind) {
  state.caseRiskFilter = '';
  if (kind === 'open' || kind === 'unacked') {
    applyQuickFilter(kind, { reload: false });
  } else if (kind === 'all') {
    clearCaseFilters({ reload: false });
  } else if (kind === 'reopened') {
    clearCaseFilters({ reload: false });
    $('#case-view').value = 'all';
    state.caseRiskFilter = 'reopened';
    applyTimeRangePreset('case', $('#dashboard-range')?.value || '7d', { reload: false });
  } else if (kind === 'ack-sla' || kind === 'resolve-sla') {
    clearCaseFilters({ reload: false });
    $('#case-view').value = 'active';
    state.caseRiskFilter = kind === 'ack-sla' ? 'ack_sla' : 'resolve_sla';
  }
  showPage('cases', { preserveCaseFilters: true });
}

function readDatetimeLocalValue(input) {
  const value = input?.value?.trim();
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function datetimeLocalValue(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function timeRangeMs(range) {
  if (range === '1h') return 60 * 60 * 1000;
  if (range === '24h') return 24 * 60 * 60 * 1000;
  if (range === '7d') return 7 * 24 * 60 * 60 * 1000;
  return 0;
}

function applyTimeRangePreset(target, range, { reload = true } = {}) {
  const fromInput = $(`#${target}-from`);
  const toInput = $(`#${target}-to`);
  const custom = $(`#${target}-time-custom`);
  if (!fromInput || !toInput) return;

  $$(`[data-time-target="${target}"]`).forEach((btn) => {
    btn.classList.toggle('active', (btn.dataset.timeRange || '') === range);
  });

  if (range === 'custom') {
    custom?.classList.remove('hidden');
    fromInput.focus();
    return;
  }

  custom?.classList.add('hidden');
  const ms = timeRangeMs(range);
  if (!ms) {
    fromInput.value = '';
    toInput.value = '';
  } else {
    const to = new Date();
    const from = new Date(to.getTime() - ms);
    fromInput.value = datetimeLocalValue(from);
    toInput.value = datetimeLocalValue(to);
  }

  if (!reload) return;
  if (target === 'case') {
    clearCaseRiskFilter();
    loadCases({ force: true, quiet: hasPageData('cases') });
  } else if (target === 'event') {
    loadEvents({ force: true, quiet: hasPageData('events') });
  }
}

function appendTimeRangeParams(params, fromSelector, toSelector) {
  const from = readDatetimeLocalValue($(fromSelector));
  const to = readDatetimeLocalValue($(toSelector));
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return params;
}

function buildCaseFilterParams() {
  const params = new URLSearchParams();
  const view = $('#case-view')?.value || 'active';
  if (view) params.set('view', view);
  const scope = $('#case-scope').value;
  if (scope && scope !== 'all') params.set('scope', scope);
  const q = $('#case-q').value.trim();
  if (q) params.set('q', q);
  if (state.caseRiskFilter) params.set('risk', state.caseRiskFilter);
  ['status', 'service', 'severity', 'assignee', 'env'].forEach((k) => {
    const el = $(`#case-${k}`);
    if (el && el.value) params.set(k, el.value);
  });
  appendTimeRangeParams(params, '#case-from', '#case-to');
  return params;
}

function buildEventFilterParams() {
  const params = new URLSearchParams();
  const q = $('#event-q')?.value?.trim();
  if (q) params.set('q', q);
  ['service', 'env', 'case_id'].forEach((k) => {
    const el = $(`#event-${k.replace('_', '-')}`);
    const val = el?.value?.trim();
    if (val) params.set(k, val);
  });
  const suppressed = $('#event-suppressed')?.value;
  if (suppressed) params.set('suppressed', suppressed);
  appendTimeRangeParams(params, '#event-from', '#event-to');
  return params;
}

function filenameFromContentDisposition(header) {
  if (!header) return null;
  const quoted = /filename="([^"]+)"/i.exec(header);
  if (quoted) return quoted[1];
  const unquoted = /filename=([^;]+)/i.exec(header);
  return unquoted ? unquoted[1].trim() : null;
}

function fallbackExportFilename(path) {
  if (path.includes('/cases/')) return 'alert-hub-cases.csv';
  if (path.includes('/events/')) return 'alert-hub-events.csv';
  return 'alert-hub-export.csv';
}

async function triggerCSVExport(button, path, params) {
  if (!button) return;
  setButtonBusy(button, true, '导出中…', '导出');
  try {
    const query = params.toString();
    const url = query ? `${path}?${query}` : path;
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      headers: exportHeaders(),
    });
    if (!res.ok) {
      const text = await res.text();
      let msg = res.statusText;
      try {
        const data = text ? JSON.parse(text) : null;
        if (data?.error) msg = data.error;
      } catch {
        if (text) msg = text;
      }
      throw new Error(msg);
    }
    await host.download(filenameFromContentDisposition(res.headers.get('Content-Disposition')) || fallbackExportFilename(path), await res.text());
  } catch (e) {
    toast(`导出失败：${e.message}`);
  } finally {
    setButtonBusy(button, false, '导出中…', '导出');
  }
}

function buildCaseExportParams() {
  const params = buildCaseFilterParams();
  params.set('limit', String(Math.max(state.cases.length, 50)));
  params.set('offset', '0');
  return params;
}

function buildEventExportParams() {
  const params = buildEventFilterParams();
  params.set('limit', String(Math.max(state.events.length, 100)));
  params.set('offset', '0');
  return params;
}

function exportCases() {
  triggerCSVExport($('#case-export'), '/api/cases/export', buildCaseExportParams());
}

function exportEvents() {
  triggerCSVExport($('#event-export'), '/api/events/export', buildEventExportParams());
}

async function loadCases({ append = false, quiet = false, force = false } = {}) {
  const params = buildCaseFilterParams();
  params.set('limit', '50');
  params.set('offset', String(append ? state.casesOffset : 0));
  const queryKey = params.toString();
  if (!append && !force && state.lastQuery.cases === queryKey && isFresh('cases')) {
    renderCasesTable();
    return;
  }

  const { signal, isStale } = beginQueryRequest('cases', { append });
  const quietMode = quiet && !append && hasPageData('cases');
  if (quietMode) setRefreshing('cases', true);
  else $('#cases-loading').classList.remove('hidden');
  $('#cases-error').classList.add('hidden');
  $('#cases-empty').classList.add('hidden');
  setButtonBusy($('#case-filter'), true, '筛选中…', '筛选');
  setButtonBusy($('#cases-load-more'), true, '加载中…', '加载更多');
  if (!append && !quietMode) {
    $('#cases-content').classList.add('hidden');
  }
  try {
    const data = await api('/api/cases?' + params.toString(), { signal });
    if (isStale()) return;
    const items = data.items || [];
    if (!append) {
      state.casesOffset = 0;
      state.cases = [];
    }
    state.cases = append ? state.cases.concat(items) : items;
    state.casesTotal = data.total ?? state.cases.length;
    state.casesOffset = state.cases.length;
    state.casesHasMore = Boolean(data.has_more);
    state.lastQuery.cases = queryKey;
    $('#cases-loading').classList.add('hidden');
    markRefresh('cases');
    renderCasesTable();
  } catch (e) {
    if (isStale() || isQueryAbortError(e)) return;
    $('#cases-loading').classList.add('hidden');
    $('#cases-error').textContent = e.message;
    $('#cases-error').classList.remove('hidden');
  } finally {
    if (!isStale()) {
      setRefreshing('cases', false);
      setButtonBusy($('#case-filter'), false, '筛选中…', '筛选');
      setButtonBusy($('#cases-load-more'), false, '加载中…', '加载更多');
    }
  }
}

function renderCasesTable() {
  updateCasesPager();
  renderCaseContext();
  const content = $('#cases-content');
  if (!state.cases.length) {
    content?.classList.add('hidden');
    $('#cases-empty')?.classList.remove('hidden');
    return;
  }
  $('#cases-empty')?.classList.add('hidden');
  content?.classList.remove('hidden');
  const tb = $('#cases-table tbody');
  tb.innerHTML = state.cases.map((c) => `
    <tr data-id="${esc(c.id)}" class="${state.currentCaseId === c.id ? 'selected' : ''}">
      <td>${severityBadge(c.severity)}</td>
      <td>${badge(c.status)}</td>
      <td title="${esc(serviceDisplayTitle(c.service, c))}">${esc(displayService(c.service, c))}</td>
      <td title="${esc(c.title)}">${esc(c.title)}</td>
      <td>${esc(c.assignee || '—')}</td>
      <td title="${esc(fmtTime(c.last_seen))}">${esc(fmtAge(c.last_seen))}</td>
      <td title="该 Case 聚合的事件条数">${c.event_count}</td>
    </tr>`).join('');
  tb.querySelectorAll('tr').forEach((tr) => {
    tr.addEventListener('click', () => openCase(tr.dataset.id));
    tr.addEventListener('mouseenter', () => prefetchCase(tr.dataset.id));
    tr.addEventListener('focus', () => prefetchCase(tr.dataset.id));
  });
  if (state.currentCaseId) {
    content?.classList.add('has-detail');
    $('#case-detail')?.classList.remove('hidden');
  }
}

function clearCaseRiskFilter() {
  state.caseRiskFilter = '';
  renderCaseContext();
}

function renderCaseContext() {
  const el = $('#case-context');
  if (!el) return;
  if (!state.caseRiskFilter) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  const label = state.caseRiskFilter === 'ack_sla'
    ? `ACK SLA 超时：open 且超过 ${domainAckMinutes()} 分钟未确认`
    : state.caseRiskFilter === 'resolve_sla'
      ? `解决 SLA 超时：活跃且超过 ${formatMinutes(domainResolveMinutes())} 未恢复`
      : '复发 Case：当前时间范围内有 reopen 记录';
  el.innerHTML = `<span>${esc(label)}</span><button type="button" class="btn btn-sm btn-link" data-clear-risk>清除</button>`;
  el.classList.remove('hidden');
  el.querySelector('[data-clear-risk]')?.addEventListener('click', () => {
    clearCaseRiskFilter();
    loadCases({ force: true, quiet: hasPageData('cases') });
  });
}

function domainAckMinutes() {
  return 15;
}

function domainResolveMinutes() {
  return 240;
}

function updateCasesPager() {
  const el = $('#cases-pager');
  if (!el) return;
  el.textContent = `显示 ${state.cases.length} / ${state.casesTotal}`;
  const btn = $('#cases-load-more');
  if (btn) {
    btn.classList.toggle('hidden', !state.casesHasMore);
    btn.disabled = !state.casesHasMore;
  }
}

function cacheCase(c) {
  if (!c?.id) return c;
  state.caseCache.set(c.id, { data: c, fetchedAt: new Date() });
  mergeCaseIntoState(c);
  return c;
}

function getCachedCase(id) {
  const hit = state.caseCache.get(id);
  if (!hit || Date.now() - hit.fetchedAt.getTime() > DETAIL_FRESH_MS) return null;
  return hit.data;
}

function mergeCaseIntoState(c) {
  if (!c?.id) return;
  const idx = state.cases.findIndex((item) => item.id === c.id);
  if (idx >= 0) {
    state.cases[idx] = { ...state.cases[idx], ...c };
  }
}

async function getCase(id, { force = false } = {}) {
  if (!force) {
    const cached = getCachedCase(id);
    if (cached) return cached;
  }
  return runOnce(`case:${id}`, async () => {
    const c = await api(`/api/cases/${encodeURIComponent(id)}`);
    return cacheCase(c);
  });
}

async function fetchCaseEvents(caseId, { force = false } = {}) {
  const cached = state.caseEventsCache.get(caseId);
  if (!force && cached && Date.now() - cached.fetchedAt.getTime() <= DETAIL_FRESH_MS) {
    return cached.items;
  }
  return runOnce(`case-events:${caseId}`, async () => {
    const data = await api(`/api/events?case_id=${encodeURIComponent(caseId)}&limit=100`);
    const items = data.items || [];
    state.caseEventsCache.set(caseId, { items, fetchedAt: new Date() });
    return items;
  });
}

async function getEvent(id, { force = false } = {}) {
  if (!force) {
    const cached = state.eventCache.get(id);
    if (cached && Date.now() - cached.fetchedAt.getTime() <= DETAIL_FRESH_MS) return cached.data;
  }
  return runOnce(`event:${id}`, async () => {
    const ev = await api(`/api/events/${encodeURIComponent(id)}`);
    state.eventCache.set(id, { data: ev, fetchedAt: new Date() });
    return ev;
  });
}

function prefetchCase(id) {
  if (!id) return;
  void getCase(id).catch(() => {});
  void fetchCaseEvents(id).catch(() => {});
}

function renderCaseActions(c) {
  const primary = primaryCaseAction(c.status);
  const primaryEl = $('#detail-primary-action');
  const secondaryEl = $('#detail-actions');
  if (primary) {
    const pending = isPending(`case:${c.id}:${primary[1]}`);
    primaryEl.innerHTML = `<button type="button" class="btn btn-primary" data-action="${esc(primary[1])}" ${pending ? 'disabled' : ''}>${pending ? '处理中…' : esc(primary[0])}</button>`;
    primaryEl.querySelector('button')?.addEventListener('click', () => caseAction(primary[1]));
  } else {
    primaryEl.innerHTML = '';
  }
  const secondary = secondaryCaseActions(c.status);
  secondaryEl.innerHTML = secondary.map(([label, act]) => {
    const pending = isPending(`case:${c.id}:${act}`);
    return `<button type="button" class="btn btn-sm btn-secondary" data-action="${esc(act)}" ${pending ? 'disabled' : ''}>${pending ? '…' : esc(label)}</button>`;
  }).join('');
  $$('#detail-actions button').forEach((btn) => btn.addEventListener('click', () => caseAction(btn.dataset.action)));

  const showTriage = ['open', 'acked', 'triaged', 'fixing'].includes(c.status);
  const canManageFields = !['closed', 'noise'].includes(c.status);
  $('#triage-panel')?.classList.toggle('hidden', !showTriage);
  $('#assign-panel')?.classList.toggle('hidden', !canManageFields);
  $('#severity-panel')?.classList.toggle('hidden', !canManageFields);
  $('#merge-panel')?.classList.toggle('hidden', c.status === 'closed');
}

function selectCaseRow(id) {
  if (state.currentCaseId !== id) state.currentCaseDetailTab = 'overview';
  state.currentCaseId = id;
  $$('#cases-table tbody tr').forEach((tr) => tr.classList.toggle('selected', tr.dataset.id === id));
  $('#cases-content').classList.add('has-detail');
  $('#case-detail').classList.remove('hidden');
}

function renderCaseDetail(c) {
  cacheCase(c);
  $('#detail-title').textContent = c.title;
  $('#detail-badges').innerHTML = `${badge(c.status)} ${severityBadge(c.severity)}`;
  const ext = c.external_url
    ? `<a href="${esc(c.external_url)}" target="_blank" rel="noopener noreferrer" class="ext-link">外部链接</a>`
    : '';
  $('#detail-meta').innerHTML = `
    <div class="meta-row"><span class="meta-label">ID</span><span class="mono">${esc(c.id)}</span></div>
    <div class="meta-row"><span class="meta-label">服务</span><span title="${esc(serviceDisplayTitle(c.service, c))}">${esc(displayService(c.service, c))}</span></div>
    <div class="meta-row"><span class="meta-label">环境</span><span>${esc(c.environment || '—')}</span></div>
    <div class="meta-row"><span class="meta-label">来源</span><span>${esc(c.source || c.cls_source || '—')}</span></div>
    <div class="meta-row"><span class="meta-label">负责人</span><span>${esc(c.assignee || '—')}</span></div>
    <div class="meta-row"><span class="meta-label">时长</span><span>首见 ${esc(fmtAge(c.first_seen))} · 最近 ${esc(fmtAge(c.last_seen))}</span></div>
    <div class="meta-row"><span class="meta-label">事件</span><span>${c.event_count} 条 · 抑制 ${c.suppressed_count} · 降级 ${c.downgraded_count}</span></div>
    <div class="meta-row"><span class="meta-label">指纹</span><code class="mono">${esc(short(c.fingerprint, 120))}</code></div>
    ${ext ? `<div class="meta-row">${ext}</div>` : ''}`;
  populateAssigneeSelect(c.assignee || '');
  void ensurePeopleLoaded().then(() => {
    if (state.currentCaseId === c.id) populateAssigneeSelect(c.assignee || '');
  });
  $('#triage-input').value = c.conclusion || '';
  if ($('#severity-select')) {
    $('#severity-select').value = c.severity || 'medium';
  }
  renderSeverityControl(c);
  renderCaseActions(c);
  renderCaseLifecycle(c.status);
  $('#detail-grouping').textContent = caseGroupingReason(c);
  $('#detail-rules').textContent = (c.matched_rules || []).join(', ') || '—';
  $('#detail-history').innerHTML = (c.history || []).slice().reverse().map((h) =>
    `<li><span class="timeline-action">${esc(h.action)}</span> <span class="timeline-actor">${esc(h.actor)}</span> ${esc(h.from)}→${esc(h.to)} ${esc(h.detail || '')} <time>${esc(fmtTime(h.created_at))}</time></li>`).join('') || '<li class="empty-item">暂无记录</li>';
  $('#detail-comments').innerHTML = (c.comments || []).map((cm) =>
    `<li><strong>${esc(cm.author)}</strong> <time>${esc(fmtTime(cm.created_at))}</time><p>${esc(cm.body)}</p></li>`).join('') || '<li class="empty-item">暂无评论</li>';
  $('#merge-target-case-id').value = '';
  setCaseDetailTab(state.currentCaseDetailTab || 'overview');
}

function renderCaseLifecycle(status) {
  const el = $('#detail-lifecycle');
  if (!el) return;
  const flow = [
    ['open', '待确认'],
    ['acked', '已确认'],
    ['triaged', '已分诊'],
    ['fixing', '修复中'],
    ['resolved', '已解决'],
  ];
  if (status === 'noise') {
    el.innerHTML = '<span class="lifecycle-step done">噪声已沉默</span><span class="lifecycle-note">后续 Event 仅记录统计，不触发通知</span>';
    return;
  }
  if (status === 'closed') {
    el.innerHTML = '<span class="lifecycle-step done">已关闭</span><span class="lifecycle-note">再次收到同指纹 Event 会重新激活</span>';
    return;
  }
  const currentIndex = Math.max(0, flow.findIndex(([key]) => key === status));
  el.innerHTML = flow.map(([key, label], index) => {
    const cls = index < currentIndex ? 'done' : index === currentIndex ? 'current' : '';
    return `<span class="lifecycle-step ${cls}" data-status="${esc(key)}">${esc(label)}</span>`;
  }).join('');
}

function caseGroupingReason(c) {
  const service = displayService(c.service, c);
  const parts = [];
  if (c.environment) parts.push(`环境 ${c.environment}`);
  if (service) parts.push(`服务 ${service}`);
  const fp = String(c.fingerprint || '');
  const fpParts = fp.split('|').filter(Boolean);
  const caller = fpParts.find((p) => /\.go:\d+/.test(p)) || '';
  if (caller) parts.push(`位置 ${caller}`);
  if (c.severity) parts.push(`级别 ${c.severity}`);
  if (fpParts.length) {
    const tail = fpParts[fpParts.length - 1];
    if (tail && tail.length < 160) parts.push(`归一化消息 ${tail}`);
  }
  const reason = parts.length ? parts.join(' / ') : short(fp, 180);
  return reason || '按事件指纹聚合；当前 Case 缺少更多可解释字段';
}

function setCaseDetailTab(tab) {
  const next = ['overview', 'events', 'timeline', 'raw'].includes(tab) ? tab : 'overview';
  state.currentCaseDetailTab = next;
  $$('.detail-tab-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.detailTab === next));
  $$('.detail-tab').forEach((el) => el.classList.toggle('active', el.id === `detail-tab-${next}`));
  if (next === 'events' && state.currentCaseId) {
    void loadCaseEvents(state.currentCaseId);
  }
}

async function loadCaseSampleEvent(c) {
  const sampleId = (c.sample_event_ids || [])[0];
  if (!sampleId) {
    $('#detail-event').textContent = '—';
    $('#detail-raw').textContent = '—';
    return;
  }
  try {
    const ev = await getEvent(sampleId);
    if (state.currentCaseId !== c.id) return;
    $('#detail-event').textContent = JSON.stringify(ev, null, 2);
    $('#detail-raw').textContent = ev.raw_payload || '—';
  } catch {
    if (state.currentCaseId !== c.id) return;
    $('#detail-event').textContent = '样本事件加载失败';
    $('#detail-raw').textContent = '—';
  }
}

async function openCase(id, { caseData = null, force = false } = {}) {
  selectCaseRow(id);
  const immediate = caseData || getCachedCase(id);
  if (immediate) {
    renderCaseDetail(immediate);
    void loadCaseTodos(id);
    void loadCaseEvents(id);
    void loadCaseSampleEvent(immediate);
    if (!force) return;
  }
  try {
    const c = caseData && !force ? caseData : await getCase(id, { force });
    if (state.currentCaseId !== id) return;
    renderCaseDetail(c);
    await Promise.all([
      loadCaseTodos(id),
      loadCaseEvents(id, { force }),
      loadCaseSampleEvent(c),
    ]);
  } catch (e) {
    toast(e.message);
  }
}

function renderCaseEvents(items) {
  $('#case-events-table tbody').innerHTML = items.map((ev) => `
    <tr>
      ${eventReceiveTimeCell(ev)}
      <td>${esc(ev.level || '—')}</td>
      <td title="${esc(ev.caller)}">${esc(short(ev.caller || '—', 28))}</td>
      <td title="${esc(ev.msg || ev.error)}">${esc(short(ev.msg || ev.error || '—', 48))}</td>
      <td>${ev.suppressed ? '<span class="badge badge-noise">抑制</span>' : '—'}</td>
    </tr>`).join('');
}

async function loadCaseEvents(caseId, { force = false } = {}) {
  const loading = $('#case-events-loading');
  const errEl = $('#case-events-error');
  const empty = $('#case-events-empty');
  const wrap = $('#case-events-wrap');
  const cached = state.caseEventsCache.get(caseId);
  const quiet = cached && !force;
  if (!quiet) loading?.classList.remove('hidden');
  errEl?.classList.add('hidden');
  empty?.classList.add('hidden');
  if (!quiet) wrap?.classList.add('hidden');
  try {
    const items = await fetchCaseEvents(caseId, { force });
    loading?.classList.add('hidden');
    if (!items.length) {
      empty?.classList.remove('hidden');
      return;
    }
    wrap?.classList.remove('hidden');
    renderCaseEvents(items);
  } catch (e) {
    loading?.classList.add('hidden');
    if (errEl) {
      errEl.textContent = e.message;
      errEl.classList.remove('hidden');
    }
  }
}

async function loadEvents({ append = false, quiet = false, force = false, prefetch = false } = {}) {
  const params = buildEventFilterParams();
  params.set('limit', '100');
  params.set('offset', String(append ? state.eventsOffset : 0));
  const queryKey = params.toString();
  if (!append && !force && state.lastQuery.events === queryKey && isFresh('events')) {
    if (!prefetch) renderEventsTable();
    return;
  }

  if (prefetch && hasPageData('events') && !force) return;

  const { signal, isStale } = beginQueryRequest('events', { append });
  const quietMode = quiet && !append && hasPageData('events');
  if (quietMode) setRefreshing('events', true);
  else $('#events-loading').classList.remove('hidden');
  $('#events-error').classList.add('hidden');
  $('#events-empty').classList.add('hidden');
  setButtonBusy($('#event-filter'), true, '筛选中…', '筛选');
  setButtonBusy($('#events-load-more'), true, '加载中…', '加载更多');
  if (!append && !quietMode) {
    $('#events-content').classList.add('hidden');
  }
  try {
    const data = await api('/api/events?' + params.toString(), { signal });
    if (isStale()) return;
    const items = data.items || [];
    if (!append) {
      state.eventsOffset = 0;
      state.events = [];
    }
    state.events = append ? state.events.concat(items) : items;
    state.eventsTotal = data.total ?? state.events.length;
    state.eventsOffset = state.events.length;
    state.eventsHasMore = Boolean(data.has_more);
    state.lastQuery.events = queryKey;
    $('#events-loading').classList.add('hidden');
    markRefresh('events');
    if (!prefetch) renderEventsTable();
  } catch (e) {
    if (isStale() || isQueryAbortError(e)) return;
    $('#events-loading').classList.add('hidden');
    $('#events-error').textContent = e.message;
    $('#events-error').classList.remove('hidden');
  } finally {
    if (!isStale()) {
      setRefreshing('events', false);
      setButtonBusy($('#event-filter'), false, '筛选中…', '筛选');
      setButtonBusy($('#events-load-more'), false, '加载中…', '加载更多');
    }
  }
}

function renderEventsTable() {
  updateEventsPager();
  if (!state.events.length) {
    $('#events-content').classList.add('hidden');
    $('#events-empty').classList.remove('hidden');
    return;
  }
  $('#events-empty').classList.add('hidden');
  $('#events-content').classList.remove('hidden');
  $('#events-table tbody').innerHTML = state.events.map(renderEventRow).join('');
  bindEventCaseLinks();
}

function renderEventRow(ev) {
  const metadataOnly = isAlarmMetadataEvent(ev);
  const caseLink = ev.case_id
    ? `<button type="button" class="link-btn mono" data-case="${esc(ev.case_id)}">${esc(short(ev.case_id, 14))}</button>`
    : metadataOnly
      ? '<span class="badge badge-muted">未形成 Case</span>'
      : '—';
  const sourceBase = ev.source || ev.cls_source || '—';
  const source = metadataOnly && sourceBase !== '—'
    ? `${sourceBase} · 元数据`
    : sourceBase;
  const handlingBadge = ev.suppressed
    ? '<span class="badge badge-noise">噪声已抑制</span>'
    : metadataOnly
      ? '<span class="badge badge-muted">仅记录元数据</span>'
      : ev.case_id
        ? '<span class="badge badge-enabled">进入 Case</span>'
        : '<span class="badge badge-open">待补齐</span>';
  const msg = ev.msg || ev.error || '—';
  const callerPart = metadataOnly
    ? '<span class="event-metadata-hint">缺少业务日志明细</span>'
    : `<span class="mono">${esc(short(ev.caller || '—', 24))}</span>`;
  const rowClass = metadataOnly ? ' class="event-row-metadata"' : '';
  return `<tr${rowClass}>
    ${eventReceiveTimeCell(ev)}
    <td>${caseLink}</td>
    <td title="${esc(serviceDisplayTitle(ev.service, ev))}">${esc(displayService(ev.service, ev))}</td>
    <td title="${esc(msg)}">${callerPart} · ${esc(short(msg, 40))}</td>
    <td>${esc(source)}</td>
    <td>${handlingBadge}</td>
  </tr>`;
}

function bindEventCaseLinks() {
  $$('#events-table [data-case]').forEach((btn) => {
    btn.addEventListener('click', () => gotoCase(btn.dataset.case));
  });
}

function updateEventsPager() {
  const el = $('#events-pager');
  if (!el) return;
  el.textContent = `显示 ${state.events.length} / ${state.eventsTotal}`;
  const btn = $('#events-load-more');
  if (btn) {
    btn.classList.toggle('hidden', !state.eventsHasMore);
    btn.disabled = !state.eventsHasMore;
  }
}

async function loadCaseTodos(caseId) {
  try {
    const data = await api(`/api/todos?case_id=${encodeURIComponent(caseId)}`);
    const items = data.items || [];
    $('#detail-todos').innerHTML = items.length
      ? items.map((td) => `<li>${badge(td.status)} <strong>${esc(td.title)}</strong> · ${esc(td.priority)} · ${esc(td.owner || '—')} <time>${esc(fmtTime(td.updated_at))}</time></li>`).join('')
      : '<li class="empty-item">暂无</li>';
  } catch {
    $('#detail-todos').innerHTML = '<li class="empty-item">加载失败</li>';
  }
}

async function createCaseTodo(e) {
  e.preventDefault();
  const id = state.currentCaseId;
  if (!id) return;
  const key = `todo:create:${id}`;
  if (isPending(key)) return;
  const btn = $('#case-todo-submit');
  setPending(key, true);
  if (btn) { btn.disabled = true; btn.textContent = '创建中…'; }
  const title = $('#case-todo-title').value.trim();
  try {
    await api(`/api/cases/${id}/todos`, {
      method: 'POST',
      body: JSON.stringify(title ? { title } : {}),
    });
    $('#case-todo-title').value = '';
    toast('Todo 已创建');
    await loadCaseTodos(id);
  } catch (err) {
    toast(err.message);
  } finally {
    setPending(key, false);
    if (btn) { btn.disabled = false; btn.textContent = '创建 Todo'; }
  }
}

function renderSeverityControl(c) {
  const pending = isPending(`case:${c.id}:severity`);
  const select = $('#severity-select');
  const submit = $('#severity-submit');
  if (select) select.disabled = pending;
  if (submit) {
    submit.disabled = pending;
    submit.textContent = pending ? '更新中…' : '更新';
  }
}

async function submitSeverity(e) {
  e.preventDefault();
  const id = state.currentCaseId;
  if (!id) return;
  const severity = $('#severity-select')?.value;
  if (!severity) {
    toast('请选择严重度');
    return;
  }
  const key = `case:${id}:severity`;
  if (isPending(key)) return;
  setPending(key, true);
  renderSeverityControl({ id });
  try {
    const updated = await api(`/api/cases/${id}/severity`, { method: 'POST', body: JSON.stringify({ severity }) });
    cacheCase(updated);
    if (state.currentCaseId === id) {
      renderCaseDetail(updated);
      void loadCaseEvents(id, { force: true });
    }
    renderCasesTable();
    toast('严重度已更新');
    void loadCases({ quiet: true, force: true });
    void loadDashboard({ quiet: true, force: true });
  } catch (err) {
    toast(err.message);
  } finally {
    setPending(key, false);
    const current = state.cases.find((c) => c.id === id);
    renderSeverityControl(current || { id });
  }
}

async function submitCaseMerge(e) {
  e.preventDefault();
  const sourceID = state.currentCaseId;
  const targetID = $('#merge-target-case-id')?.value?.trim();
  if (!sourceID || !targetID) {
    toast('请输入目标 Case ID');
    return;
  }
  if (sourceID === targetID) {
    toast('不能合并到自身');
    return;
  }
  const key = `case:${sourceID}:merge`;
  if (isPending(key)) return;
  const btn = $('#merge-submit');
  setPending(key, true);
  if (btn) {
    btn.disabled = true;
    btn.textContent = '合并中…';
  }
  try {
    const merged = await api(`/api/cases/${encodeURIComponent(sourceID)}/merge`, {
      method: 'POST',
      body: JSON.stringify({ target_case_id: targetID }),
    });
    state.caseCache.delete(sourceID);
    state.caseEventsCache.delete(sourceID);
    cacheCase(merged);
    state.currentCaseId = merged.id || targetID;
    renderCaseDetail(merged);
    toast('Case 已合并');
    await Promise.all([
      loadFilterOptions({ quiet: true, force: true }),
      loadCases({ quiet: true, force: true }),
      loadDashboard({ quiet: true, force: true }),
      loadCaseEvents(state.currentCaseId, { force: true }),
    ]);
  } catch (err) {
    toast(`合并失败：${err.message}`);
  } finally {
    setPending(key, false);
    if (btn) {
      btn.disabled = false;
      btn.textContent = '合并';
    }
  }
}

async function submitAssign(e) {
  e.preventDefault();
  const id = state.currentCaseId;
  if (!id) return;
  const assignee = $('#assign-input').value.trim();
  if (!assignee) {
    toast('请选择负责人');
    return;
  }
  await caseAction('assign', { assignee });
}

async function submitTriage(e, status = 'triaged') {
  e.preventDefault();
  const id = state.currentCaseId;
  if (!id) return;
  const conclusion = $('#triage-input').value.trim();
  await caseAction(status === 'fixing' ? 'fixing' : 'triage', { conclusion, status });
}

async function loadTodos({ append = false, quiet = false, force = false } = {}) {
  const params = new URLSearchParams();
  const scope = $('#todo-scope').value;
  if (scope && scope !== 'all') params.set('scope', scope);
  const q = $('#todo-q').value.trim();
  if (q) params.set('q', q);
  ['status', 'owner', 'team', 'service'].forEach((k) => {
    const el = $(`#todo-${k}`);
    if (el && el.value) params.set(k, el.value);
  });
  params.set('limit', '100');
  params.set('offset', String(append ? state.todosOffset : 0));
  const queryKey = params.toString();
  if (!append && !force && state.lastQuery.todos === queryKey && isFresh('todos')) {
    renderTodosTable();
    return;
  }

  const { signal, isStale } = beginQueryRequest('todos', { append });
  const quietMode = quiet && !append && hasPageData('todos');
  if (quietMode) setRefreshing('todos', true);
  else $('#todos-loading').classList.remove('hidden');
  $('#todos-error').classList.add('hidden');
  $('#todos-empty').classList.add('hidden');
  setButtonBusy($('#todo-filter'), true, '筛选中…', '筛选');
  setButtonBusy($('#todos-load-more'), true, '加载中…', '加载更多');
  if (!quietMode && !append) $('#todos-content').classList.add('hidden');
  try {
    const data = await api('/api/todos?' + params.toString(), { signal });
    if (isStale()) return;
    const items = data.items || [];
    if (!append) {
      state.todosOffset = 0;
      state.todos = [];
    }
    state.todos = append ? state.todos.concat(items) : items;
    state.todosTotal = data.total ?? state.todos.length;
    state.todosOffset = state.todos.length;
    state.todosHasMore = Boolean(data.has_more);
    state.lastQuery.todos = queryKey;
    $('#todos-loading').classList.add('hidden');
    markRefresh('todos');
    renderTodosTable();
  } catch (e) {
    if (isStale() || isQueryAbortError(e)) return;
    $('#todos-loading').classList.add('hidden');
    $('#todos-error').textContent = e.message;
    $('#todos-error').classList.remove('hidden');
  } finally {
    if (!isStale()) {
      setRefreshing('todos', false);
      setButtonBusy($('#todo-filter'), false, '筛选中…', '筛选');
      setButtonBusy($('#todos-load-more'), false, '加载中…', '加载更多');
    }
  }
}

function renderTodosTable() {
  updateTodosPager();
  if (!state.todos.length) {
    $('#todos-empty').classList.remove('hidden');
    $('#todos-content')?.classList.add('hidden');
    return;
  }
  $('#todos-empty').classList.add('hidden');
  $('#todos-content')?.classList.remove('hidden');
  $('#todos-table tbody').innerHTML = state.todos.map((td) => `
    <tr>
      <td title="${esc(td.title)}">${esc(short(td.title, 40))}</td>
      <td>${badge(td.status)}</td>
      <td>${esc(td.priority)}</td>
      <td>${esc(td.owner || '—')}</td>
      <td>${esc(td.team || '—')}</td>
      <td>${esc(td.service || '—')}</td>
      <td>${td.due_at ? fmtTime(td.due_at) : '—'}</td>
      <td class="mono">${esc(short(td.case_id || '—', 12))}</td>
      <td class="todo-actions">${todoActionButtons(td)}</td>
    </tr>`).join('');
  $$('#todos-table .todo-actions button').forEach((btn) => {
    btn.addEventListener('click', () => todoAction(btn.dataset.id, btn.dataset.action));
  });
}

function updateTodosPager() {
  const el = $('#todos-pager');
  if (!el) return;
  el.textContent = `显示 ${state.todos.length} / ${state.todosTotal}`;
  const btn = $('#todos-load-more');
  if (btn) {
    btn.classList.toggle('hidden', !state.todosHasMore);
    btn.disabled = !state.todosHasMore;
  }
}

function todoActionButtons(td) {
  const actions = [];
  if (td.status === 'open') actions.push(['开始', 'start']);
  if (td.status === 'open' || td.status === 'doing') {
    actions.push(['完成', 'complete']);
    actions.push(['取消', 'cancel']);
  }
  if (td.status === 'done' || td.status === 'canceled') actions.push(['重开', 'reopen']);
  return actions.map(([label, act]) => {
    const pending = isPending(`todo:${td.id}:${act}`);
    return `<button type="button" class="btn btn-sm" data-id="${esc(td.id)}" data-action="${esc(act)}" ${pending ? 'disabled' : ''}>${pending ? '…' : esc(label)}</button>`;
  }).join(' ');
}

async function todoAction(id, action) {
  const key = `todo:${id}:${action}`;
  if (isPending(key)) return;
  setPending(key, true);
  try {
    const updated = await api(`/api/todos/${id}/${action}`, { method: 'POST', body: '{}' });
    const idx = state.todos.findIndex((td) => td.id === id);
    if (idx >= 0) {
      state.todos[idx] = updated;
      renderTodosTable();
    }
    toast('已更新');
    void loadTodos({ quiet: true, force: true });
  } catch (e) {
    toast(e.message);
  } finally {
    setPending(key, false);
  }
}

async function caseAction(action, opts = {}) {
  const id = state.currentCaseId;
  if (!id) return;
  const key = `case:${id}:${action}`;
  if (isPending(key)) return;
  setPending(key, true);
  renderCaseActions({ id, status: state.cases.find((c) => c.id === id)?.status || 'open' });
  try {
    let updated;
    if (action === 'assign') {
      const assignee = opts.assignee || $('#assign-input')?.value?.trim();
      if (!assignee) {
        toast('请输入 Assignee');
        return;
      }
      updated = await api(`/api/cases/${id}/assign`, { method: 'POST', body: JSON.stringify({ assignee }) });
    } else if (action === 'triage') {
      const conclusion = opts.conclusion ?? $('#triage-input')?.value?.trim() ?? '';
      updated = await api(`/api/cases/${id}/triage`, { method: 'POST', body: JSON.stringify({ conclusion, status: opts.status || 'triaged' }) });
    } else if (action === 'fixing') {
      const conclusion = opts.conclusion ?? $('#triage-input')?.value?.trim() ?? '';
      updated = await api(`/api/cases/${id}/triage`, { method: 'POST', body: JSON.stringify({ conclusion, status: 'fixing' }) });
    } else {
      updated = await api(`/api/cases/${id}/${action}`, { method: 'POST', body: '{}' });
    }
    cacheCase(updated);
    if (state.currentCaseId === id) {
      renderCaseDetail(updated);
      void loadCaseTodos(id);
      void loadCaseEvents(id, { force: true });
      void loadCaseSampleEvent(updated);
    }
    renderCasesTable();
    toast('操作成功');
    void loadCases({ quiet: true, force: true });
    void loadDashboard({ quiet: true, force: true });
  } catch (e) {
    toast(e.message);
  } finally {
    setPending(key, false);
    const current = state.cases.find((c) => c.id === id);
    if (current) renderCaseActions(current);
  }
}

async function loadOwners({ quiet = false, force = false } = {}) {
  const epoch = state.catalogEpoch;
  if (!force && isFresh('owners') && state.owners.length) {
    renderOwnersTable();
    return;
  }
  const quietMode = quiet && hasPageData('owners');
  if (quietMode) setRefreshing('owners', true);
  else $('#owners-loading').classList.remove('hidden');
  $('#owners-error').classList.add('hidden');
  $('#owners-empty').classList.add('hidden');
  try {
    const [data] = await Promise.all([
      runOnce('owners', () => api('/api/owners')),
      ensurePeopleLoaded({ force }),
      ensureTeamsLoaded(),
    ]);
    if (epoch !== state.catalogEpoch) return;
    state.owners = data.items || [];
    $('#owners-loading').classList.add('hidden');
    markRefresh('owners');
    renderOwnersTable();
  } catch (e) {
    $('#owners-loading').classList.add('hidden');
    $('#owners-error').textContent = e.message;
    $('#owners-error').classList.remove('hidden');
  } finally {
    setRefreshing('owners', false);
  }
}

function ownerRouteWarnings(owner) {
  if (!owner || owner.discovered || owner.configured === false) return [];
  const warnings = [];
  const primary = findActivePerson(owner.primary_owner);
  if (primary?.wecom_userid) {
    const notify = String(owner.notify_target || '').trim();
    if (!notify) warnings.push('通知目标为空');
    else if (notify !== primary.wecom_userid) warnings.push('通知目标与负责人企微ID不一致');
  }
  if (String(owner.primary_owner || '').trim() && !primary) {
    warnings.push('主负责人未匹配人员');
  }
  if (String(owner.backup_owner || '').trim() && !findActivePerson(owner.backup_owner)) {
    warnings.push('备份负责人未匹配人员');
  }
  if (owner.team_id) {
    const team = state.teams.find((t) => t.id === owner.team_id);
    if (!team) warnings.push('团队不可用');
    else if (team.enabled === false || team.merged_into_team_id) warnings.push('团队已停用或合并');
  } else if (String(owner.team || '').trim()) {
    const match = state.teams.find((t) => t.name === owner.team || (t.aliases || []).includes(owner.team));
    if (!match) warnings.push('团队未登记');
  }
  return warnings;
}

function renderOwnerRouteWarnings(owner) {
  const warnings = ownerRouteWarnings(owner);
  if (!warnings.length) return '';
  const title = warnings.join('；');
  return `<span class="route-warning-badge" title="${esc(title)}">路由风险</span>`;
}

function renderOwnersTable() {
  if (!state.owners.length) {
    $('#owners-empty').classList.remove('hidden');
    $('#owners-content')?.classList.add('hidden');
    return;
  }
  $('#owners-empty').classList.add('hidden');
  $('#owners-content')?.classList.remove('hidden');
  $('#owners-table tbody').innerHTML = state.owners.map((o) => {
    const discovered = o.discovered || o.configured === false;
    const serviceCell = discovered
      ? `${esc(o.service)} <span class="badge badge-open">待维护</span>`
      : esc(o.service);
    const routeWarnings = discovered ? '' : renderOwnerRouteWarnings(o);
    const primary = discovered ? '—' : `${esc(o.primary_owner || '—')}${routeWarnings}`;
    const backup = discovered ? '—' : esc(o.backup_owner || '—');
    const team = discovered ? '—' : esc(o.team || '—');
    const notify = discovered ? '—' : esc(o.notify_target || '—');
    const enabled = discovered
      ? '—'
      : (o.enabled ? '<span class="badge badge-enabled">是</span>' : '<span class="badge badge-closed">否</span>');
    const actions = discovered
      ? `<button type="button" class="btn btn-sm" data-fill="${esc(o.service)}">填写</button>`
      : `<button type="button" class="btn btn-sm" data-edit="${esc(o.id)}">编辑</button>
        <button type="button" class="btn btn-sm btn-secondary" data-del="${esc(o.id)}">删除</button>`;
    return `
    <tr>
      <td>${serviceCell}</td>
      <td>${primary}</td>
      <td>${backup}</td>
      <td>${team}</td>
      <td>${notify}</td>
      <td>${o.case_count ?? 0}</td>
      <td>${enabled}</td>
      <td class="row-actions">${actions}</td>
    </tr>`;
  }).join('');
  $$('#owners-table [data-edit]').forEach((b) => b.addEventListener('click', () => openOwnerDialog({ id: b.dataset.edit })));
  $$('#owners-table [data-fill]').forEach((b) => b.addEventListener('click', () => openOwnerDialog({ service: b.dataset.fill, discovered: true })));
  $$('#owners-table [data-del]').forEach((b) => b.addEventListener('click', () => deleteOwner(b.dataset.del, b)));
}

function upsertOwnerInState(owner) {
  if (!owner?.id) return;
  const configured = { ...owner, configured: true, discovered: false };
  const byID = state.owners.findIndex((o) => o.id === configured.id);
  if (byID >= 0) {
    state.owners[byID] = configured;
    return;
  }
  const discovered = state.owners.findIndex((o) => !o.id && o.service === configured.service);
  if (discovered >= 0) {
    state.owners[discovered] = configured;
    return;
  }
  state.owners.unshift(configured);
}

async function openOwnerDialog({ id = '', service = '', discovered = false } = {}) {
  await Promise.all([ensureTeamsLoaded(), ensurePeopleLoaded()]);
  const o = id
    ? (state.owners.find((x) => x.id === id) || {})
    : (state.owners.find((x) => x.service === service && (x.discovered || x.configured === false)) || { service });
  $('#owner-id').value = o.id || '';
  $('#owner-service').value = o.service || service || '';
  $('#owner-primary').value = o.primary_owner || '';
  $('#owner-backup').value = o.backup_owner || '';
  setTeamField('owner', o);
  ownerAutoTeam = true;
  ownerPrimarySeen = o.primary_owner || '';
  $('#owner-notify').value = o.notify_target || '';
  $('#owner-enabled').checked = discovered ? true : o.enabled !== false;
  const serviceInput = $('#owner-service');
  if (serviceInput) serviceInput.readOnly = !!discovered;
  syncOwnerDerivedFields();
  $('#owner-dialog').showModal();

  const saveBtn = $('#owner-save');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = '加载人员…';
  }
  ensurePeopleLoaded().then(() => {
    populatePeopleDatalist();
    syncOwnerDerivedFields();
  }).finally(() => {
    if (saveBtn && !isPending('owner:save')) {
      saveBtn.disabled = false;
      saveBtn.textContent = '保存';
    }
  });
}

async function saveOwner(e) {
  e.preventDefault();
  const btn = $('#owner-save');
  if (isPending('owner:save')) return;
  setPending('owner:save', true);
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  try {
  const id = $('#owner-id').value;
  const payload = {
    service: $('#owner-service').value.trim(),
    primary_owner: $('#owner-primary').value.trim(),
    backup_owner: $('#owner-backup').value.trim(),
    ...readTeamField('owner'),
    notify_target: $('#owner-notify').value.trim(),
    enabled: $('#owner-enabled').checked,
  };
    const saved = id
      ? await api(`/api/owners/${id}`, { method: 'PUT', body: JSON.stringify({ ...payload, id }) })
      : await api('/api/owners', { method: 'POST', body: JSON.stringify(payload) });
    upsertOwnerInState(saved);
    renderOwnersTable();
    $('#owner-dialog').close();
    toast('已保存');
    void invalidateTeamDependentData().catch((err) => toast(`已保存，刷新失败：${err.message}`));
  } catch (err) {
    toast(err.message);
  } finally {
    setPending('owner:save', false);
    if (btn) { btn.disabled = false; btn.textContent = '保存'; }
  }
}

async function deleteOwner(id, button = null) {
  if (!await pluginConfirm('确认删除?')) return;
  const key = `owner:del:${id}`;
  if (isPending(key)) return;
  setPending(key, true);
  if (button) {
    button.disabled = true;
    button.textContent = '删除中…';
  }
  try {
    await api(`/api/owners/${id}`, { method: 'DELETE' });
    state.owners = state.owners.filter((o) => o.id !== id);
    renderOwnersTable();
    toast('已删除');
    void Promise.all([
      loadOwners({ quiet: true, force: true }),
      loadFilterOptions({ quiet: true, force: true }),
      loadDashboard({ quiet: true, force: true }),
    ]);
  } catch (e) {
    toast(e.message);
  } finally {
    setPending(key, false);
    if (button) {
      button.disabled = false;
      button.textContent = '删除';
    }
  }
}

async function loadPeople({ quiet = false, force = false } = {}) {
  if (!force && isFresh('people') && state.people.length) {
    renderPeopleTable();
    return;
  }
  const quietMode = quiet && hasPageData('people');
  if (quietMode) setRefreshing('people', true);
  else $('#people-loading').classList.remove('hidden');
  $('#people-error').classList.add('hidden');
  $('#people-empty').classList.add('hidden');
  try {
    const data = await runOnce('people-page', () => api('/api/people'));
    state.people = data.items || [];
    $('#people-loading').classList.add('hidden');
    markRefresh('people');
    populatePeopleDatalist();
    void ensureTeamsLoaded();
    renderPeopleTable();
  } catch (e) {
    $('#people-loading').classList.add('hidden');
    $('#people-error').textContent = e.message;
    $('#people-error').classList.remove('hidden');
  } finally {
    setRefreshing('people', false);
  }
}

function renderPeopleTable() {
  if (!state.people.length) {
    $('#people-empty').classList.remove('hidden');
    $('#people-content')?.classList.add('hidden');
    return;
  }
  $('#people-empty').classList.add('hidden');
  $('#people-content')?.classList.remove('hidden');
  $('#people-table tbody').innerHTML = state.people.map((p) => `
    <tr>
      <td>${esc(p.username)}</td>
      <td>${esc(p.name || '—')}</td>
      <td>${esc(p.email || '—')}</td>
      <td>${esc(p.team || '—')}</td>
      <td>${esc(p.jira_account || '—')}</td>
      <td>${esc(p.wecom_userid || '—')}</td>
      <td>${badge(p.status === 'disabled' ? 'disabled' : 'active')}</td>
      <td>${esc(p.source || '—')}</td>
      <td class="row-actions">
        <button type="button" class="btn btn-sm" data-edit="${esc(p.id)}">编辑</button>
        <button type="button" class="btn btn-sm btn-secondary" data-del="${esc(p.id)}">删除</button>
      </td>
    </tr>`).join('');
  $$('#people-table [data-edit]').forEach((b) => b.addEventListener('click', () => openPersonDialog(b.dataset.edit)));
  $$('#people-table [data-del]').forEach((b) => b.addEventListener('click', () => deletePerson(b.dataset.del, b)));
}

function upsertPersonInState(person) {
  if (!person?.id) return;
  const idx = state.people.findIndex((p) => p.id === person.id);
  if (idx >= 0) {
    state.people[idx] = person;
  } else {
    state.people.unshift(person);
  }
}

async function openPersonDialog(id = '') {
  await ensureTeamsLoaded();
  const p = id ? (state.people.find((x) => x.id === id) || {}) : {};
  $('#person-id').value = p.id || '';
  $('#person-username').value = p.username || '';
  $('#person-name').value = p.name || '';
  $('#person-email').value = p.email || '';
  setTeamField('person', p);
  $('#person-jira').value = p.jira_account || '';
  $('#person-wecom').value = p.wecom_userid || '';
  $('#person-status').value = p.status || 'active';
  void ensureTeamsLoaded().then(() => populateTeamsDatalist());
  const usernameInput = $('#person-username');
  if (usernameInput) usernameInput.readOnly = !!id;
  $('#person-dialog').showModal();
}

async function savePerson(e) {
  e.preventDefault();
  const btn = $('#person-save');
  if (isPending('person:save')) return;
  setPending('person:save', true);
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  const payload = {
    username: $('#person-username').value.trim(),
    name: $('#person-name').value.trim(),
    email: $('#person-email').value.trim(),
    ...readTeamField('person'),
    jira_account: $('#person-jira').value.trim(),
    wecom_userid: $('#person-wecom').value.trim(),
    status: $('#person-status').value,
  };
  const id = $('#person-id').value;
  try {
    const saved = id
      ? await api(`/api/people/${id}`, { method: 'PUT', body: JSON.stringify({ ...payload, id }) })
      : await api('/api/people', { method: 'POST', body: JSON.stringify(payload) });
    upsertPersonInState(saved);
    renderPeopleTable();
    populatePeopleDatalist();
    populateAssigneeSelect($('#assign-input')?.value || '');
    $('#person-dialog').close();
    toast('已保存');
    void invalidateTeamDependentData().catch((err) => toast(`已保存，刷新失败：${err.message}`));
  } catch (err) {
    toast(err.message);
  } finally {
    setPending('person:save', false);
    if (btn) { btn.disabled = false; btn.textContent = '保存'; }
  }
}

async function deletePerson(id, button = null) {
  if (!await pluginConfirm('删除后会清空 Case/Todo 指派，并移除 Owner 引用，确认删除?')) return;
  const key = `person:del:${id}`;
  if (isPending(key)) return;
  setPending(key, true);
  if (button) {
    button.disabled = true;
    button.textContent = '删除中…';
  }
  try {
    await api(`/api/people/${id}`, { method: 'DELETE' });
    state.people = state.people.filter((p) => p.id !== id);
    renderPeopleTable();
    populateAssigneeSelect($('#assign-input')?.value || '');
    toast('已删除');
    void Promise.all([
      loadPeople({ quiet: true, force: true }),
      loadOwners({ quiet: true, force: true }),
      loadCases({ quiet: true, force: true }),
      loadFilterOptions({ quiet: true, force: true }),
      loadDashboard({ quiet: true, force: true }),
    ]);
  } catch (e) {
    toast(e.message);
  } finally {
    setPending(key, false);
    if (button) {
      button.disabled = false;
      button.textContent = '删除';
    }
  }
}

async function loadTeams({ quiet = false, force = false } = {}) {
  if (!force && isFresh('teams') && state.teams.length) {
    renderTeamsTable();
    populateTeamsDatalist();
    return;
  }
  const quietMode = quiet && hasPageData('teams');
  if (quietMode) setRefreshing('teams', true);
  else $('#teams-loading')?.classList.remove('hidden');
  $('#teams-error')?.classList.add('hidden');
  $('#teams-empty')?.classList.add('hidden');
  try {
    const data = await runOnce('teams-page', () => api('/api/teams'));
    state.teams = data.items || [];
    $('#teams-loading')?.classList.add('hidden');
    markRefresh('teams');
    populateTeamsDatalist();
    renderTeamsTable();
  } catch (e) {
    $('#teams-loading')?.classList.add('hidden');
    $('#teams-error').textContent = e.message;
    $('#teams-error').classList.remove('hidden');
  } finally {
    setRefreshing('teams', false);
  }
}

function renderTeamsTable() {
  $('#teams-empty').classList.toggle('hidden', !!state.teams.length);
  $('#teams-content').classList.toggle('hidden', !state.teams.length);
  $('#teams-table tbody').innerHTML = state.teams.map(t => `
    <tr>
      <td title="${esc(t.id)}">${esc(t.name)}</td>
      <td>${esc(t.display_name || '—')}</td>
      <td>${t.people_count ?? 0}</td><td>${t.owner_count ?? 0}</td>
      <td>${esc(t.jira_project_key || '—')}</td>
      <td>${esc(t.default_assignee || '—')}</td>
      <td>${t.merged_into_team_id ? '已合并' : t.enabled === false ? '已停用' : '启用'}</td>
      <td class="row-actions">
        <button type="button" class="btn btn-sm" data-edit-team="${esc(t.id)}" ${t.merged_into_team_id ? 'disabled' : ''}>编辑</button>
        <button type="button" class="btn btn-sm btn-secondary" data-manage-team="${esc(t.id)}">引用与变更</button>
      </td>
    </tr>`).join('');
  $$('#teams-table [data-edit-team]').forEach(b => b.addEventListener('click', () => openTeamDialog(b.dataset.editTeam)));
  $$('#teams-table [data-manage-team]').forEach(b => b.addEventListener('click', () => openTeamManagement(b.dataset.manageTeam)));
}

let teamManagement = { id: '', usage: null, seq: 0 };
async function openTeamManagement(id) {
  const seq = ++teamManagement.seq;
  teamManagement.id = id;
  teamManagement.usage = null;
  const team = state.teams.find(t => t.id === id);
  $('#team-manage-name').textContent = teamLabel(team);
  $('#team-manage-usage').replaceChildren();
  $('#team-manage-services').textContent = '';
  $('#team-manage-confirm').checked = false;
  $('#team-manage-error').classList.add('hidden');
  $('#team-manage-retry').classList.add('hidden');
  $('#team-manage-loading').classList.remove('hidden');
  $('#team-manage-submit').disabled = true;
  $('#team-manage-mode').disabled = true;
  $('#team-merge-target').disabled = true;
  $('#team-manage-impact').textContent = '';
  const dialog = $('#team-manage-dialog');
  if (!dialog.open) dialog.showModal();
  try {
    const usage = await api(`/api/teams/${encodeURIComponent(id)}/usage`);
    if (seq !== teamManagement.seq || !dialog.open) return;
    teamManagement.usage = usage;
    const items = [['人员', usage.people_count], ['服务路由', usage.owner_count], ['待办', usage.todo_count], ['账号', usage.auth_user_count], ['历史指标', usage.metric_bucket_count], ['状态汇总', usage.status_rollup_count]];
    $('#team-manage-usage').innerHTML = items.map(([label,count]) => `<div><dt>${label}</dt><dd>${count ?? 0}</dd></div>`).join('');
    $('#team-manage-services').textContent = (usage.owner_services || []).join(' · ');
    const inUse = items.some(([,n]) => n > 0) || usage.has_historical;
    const mode = $('#team-manage-mode');
    mode.querySelector('[value="delete"]').disabled = inUse || !!team.merged_into_team_id;
    mode.querySelector('[value="toggle"]').textContent = team.enabled === false ? '启用团队' : '停用团队';
    mode.disabled = !!team.merged_into_team_id;
    mode.value = team.merged_into_team_id ? 'toggle' : 'merge';
    const targets = state.teams.filter(t => t.id !== id && t.enabled !== false && !t.merged_into_team_id);
    $('#team-merge-target').innerHTML = '<option value="">选择目标团队</option>' + targets.map(t => `<option value="${esc(t.id)}">${esc(teamLabel(t))}</option>`).join('');
    $('#team-merge-target').disabled = false;
    updateTeamManagement();
  } catch (err) {
    if (seq !== teamManagement.seq) return;
    $('#team-manage-error').textContent = '引用核对失败：' + err.message;
    $('#team-manage-error').classList.remove('hidden');
    $('#team-manage-retry').classList.remove('hidden');
  } finally {
    if (seq === teamManagement.seq) $('#team-manage-loading').classList.add('hidden');
  }
}

function updateTeamManagement() {
  const team = state.teams.find(t => t.id === teamManagement.id);
  const mode = $('#team-manage-mode').value;
  $('#team-merge-target-label').classList.toggle('hidden', mode !== 'merge');
  $('#team-merge-target').required = mode === 'merge';
  const impact = mode === 'merge'
    ? '人员、服务路由、待办和历史统计转移到目标团队。原团队保留合并记录。'
    : mode === 'toggle'
      ? team?.enabled === false ? '恢复新成员和新服务的团队指派。' : '保留当前人员、服务和历史数据，不再接受新的团队指派。'
      : '仅删除没有人员、服务、待办和历史统计引用的团队。';
  $('#team-manage-impact').textContent = team?.merged_into_team_id ? '此团队已合并，不能重新启用。' : impact;
  const validTarget = mode !== 'merge' || !!$('#team-merge-target').value;
  $('#team-manage-submit').disabled = !teamManagement.usage || !!team?.merged_into_team_id || !validTarget || !$('#team-manage-confirm').checked || isPending('team:manage');
}

async function submitTeamManagement(e) {
  e.preventDefault();
  if (!teamManagement.usage || !$('#team-manage-confirm').checked || isPending('team:manage')) return;
  const team = state.teams.find(t => t.id === teamManagement.id);
  if (!team || team.merged_into_team_id) return;
  const mode = $('#team-manage-mode').value;
  const target = $('#team-merge-target').value;
  if (mode === 'merge' && !target) return;
  setPending('team:manage', true);
  $('#team-manage-submit').disabled = true;
  $('#team-manage-submit').textContent = '提交中…';
  $('#team-manage-close').disabled = true;
  $('#team-manage-error').classList.add('hidden');
  try {
    const path = `/api/teams/${encodeURIComponent(team.id)}`;
    if (mode === 'merge') await api(path + '/merge', { method: 'POST', body: JSON.stringify({ target_team_id: target }) });
    else if (mode === 'toggle') await api(path, { method: 'PUT', body: JSON.stringify({ ...team, enabled: team.enabled === false }) });
    else await api(path, { method: 'DELETE' });
    $('#team-manage-dialog').close();
    toast('团队变更已完成');
    await invalidateTeamDependentData();
  } catch (err) {
    $('#team-manage-error').textContent = err.message;
    $('#team-manage-error').classList.remove('hidden');
  } finally {
    setPending('team:manage', false);
    $('#team-manage-close').disabled = false;
    $('#team-manage-submit').textContent = '确认变更';
    updateTeamManagement();
  }
}

async function invalidateTeamDependentData() {
  state.catalogEpoch++;
  invalidateQueryRequests();
  state.lastRefresh = {};
  state.lastQuery = {};
  state.filterOptions = null;
  state.caseCache.clear();
  void loadMe();
  await ensureTeamsLoaded({ force: true });
  await loadPageData(state.currentPage, { quiet: true, force: true });
}

function upsertTeamInState(team) {
  if (!team?.id) return;
  const idx = state.teams.findIndex((t) => t.id === team.id);
  if (idx >= 0) state.teams[idx] = team;
  else state.teams.unshift(team);
}

function openTeamDialog(id = '') {
  const t = id ? (state.teams.find((x) => x.id === id) || {}) : { enabled: true };
  $('#team-id').value = t.id || '';
  $('#team-name').value = t.name || '';
  $('#team-display-name').value = t.display_name || '';
  $('#team-jira-project').value = t.jira_project_key || '';
  $('#team-default-assignee').value = t.default_assignee || '';
  $('#team-description').value = t.description || '';
  $('#team-enabled').checked = t.enabled !== false;
  $('#team-dialog')?.showModal();
}

async function saveTeam(e) {
  e.preventDefault();
  const btn = $('#team-save');
  if (isPending('team:save')) return;
  setPending('team:save', true);
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  const payload = {
    name: $('#team-name').value.trim(),
    display_name: $('#team-display-name').value.trim(),
    jira_project_key: $('#team-jira-project').value.trim(),
    default_assignee: $('#team-default-assignee').value.trim(),
    description: $('#team-description').value.trim(),
    enabled: $('#team-enabled').checked,
  };
  const id = $('#team-id').value;
  try {
    const saved = id
      ? await api(`/api/teams/${id}`, { method: 'PUT', body: JSON.stringify({ ...payload, id }) })
      : await api('/api/teams', { method: 'POST', body: JSON.stringify(payload) });
    upsertTeamInState(saved);
    renderTeamsTable();
    populateTeamsDatalist();
    $('#team-dialog')?.close();
    toast('已保存');
    await invalidateTeamDependentData();
  } catch (err) {
    toast(err.message);
  } finally {
    setPending('team:save', false);
    if (btn) { btn.disabled = false; btn.textContent = '保存'; }
  }
}


async function loadRules({ quiet = false, force = false } = {}) {
  if (!force && isFresh('rules') && state.rules.length) {
    renderRulesTable();
    return;
  }
  const quietMode = quiet && hasPageData('rules');
  if (quietMode) setRefreshing('rules', true);
  else $('#rules-loading').classList.remove('hidden');
  $('#rules-error').classList.add('hidden');
  $('#rules-empty').classList.add('hidden');
  try {
    const data = await runOnce('rules', () => api('/api/rules'));
    state.rules = data.items || [];
    $('#rules-loading').classList.add('hidden');
    markRefresh('rules');
    renderRulesTable();
  } catch (e) {
    $('#rules-loading').classList.add('hidden');
    $('#rules-error').textContent = e.message;
    $('#rules-error').classList.remove('hidden');
  } finally {
    setRefreshing('rules', false);
  }
}

function renderRulesTable() {
  if (!state.rules.length) {
    $('#rules-empty').classList.remove('hidden');
    $('#rules-content')?.classList.add('hidden');
    return;
  }
  $('#rules-empty').classList.add('hidden');
  $('#rules-content')?.classList.remove('hidden');
  $('#rules-table tbody').innerHTML = state.rules.map((r) => `
    <tr>
      <td>${esc(r.name)}</td>
      <td>${badge(r.action)}</td>
      <td>${r.priority}</td>
      <td>${r.enabled ? '是' : '否'}</td>
      <td>${r.hit_count}</td>
      <td class="row-actions">
        <button type="button" class="btn btn-sm" data-edit="${esc(r.id)}">编辑</button>
        <button type="button" class="btn btn-sm btn-secondary" data-del="${esc(r.id)}">删除</button>
      </td>
    </tr>`).join('');
  $$('#rules-table [data-edit]').forEach((b) => b.addEventListener('click', () => editRule(b.dataset.edit)));
  $$('#rules-table [data-del]').forEach((b) => b.addEventListener('click', () => deleteRule(b.dataset.del, b)));
}

function upsertRuleInState(rule) {
  if (!rule?.id) return;
  const idx = state.rules.findIndex((r) => r.id === rule.id);
  if (idx >= 0) {
    state.rules[idx] = rule;
  } else {
    state.rules.unshift(rule);
  }
}

function editRule(id) {
  const r = state.rules.find((x) => x.id === id) || { conditions: {} };
  $('#rule-id').value = r.id || '';
  $('#rule-name').value = r.name || '';
  $('#rule-action').value = r.action || 'suppress';
  $('#rule-priority').value = r.priority || 100;
  $('#rule-reason').value = r.reason || '';
  $('#rule-service').value = r.conditions?.service || '';
  $('#rule-callers').value = (r.conditions?.callers || []).join(', ');
  $('#rule-msg').value = r.conditions?.msg_contains || '';
  $('#rule-error').value = r.conditions?.error_contains || '';
  $('#rule-enabled').checked = !!r.enabled;
  $('#rule-dryrun-result').classList.add('hidden');
  $('#rule-dialog').showModal();
}

function buildRuleFromForm() {
  const callers = $('#rule-callers').value.split(',').map((s) => s.trim()).filter(Boolean);
  return {
    id: $('#rule-id').value,
    name: $('#rule-name').value.trim(),
    action: $('#rule-action').value,
    priority: Number($('#rule-priority').value || 100),
    reason: $('#rule-reason').value.trim(),
    enabled: $('#rule-enabled').checked,
    conditions: {
      service: $('#rule-service').value.trim(),
      callers,
      msg_contains: $('#rule-msg').value.trim(),
      error_contains: $('#rule-error').value.trim(),
    },
  };
}

async function saveRule(e) {
  e.preventDefault();
  const btn = $('#rule-save');
  if (isPending('rule:save')) return;
  setPending('rule:save', true);
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  const rule = buildRuleFromForm();
  try {
    const saved = rule.id
      ? await api(`/api/rules/${rule.id}`, { method: 'PUT', body: JSON.stringify(rule) })
      : await api('/api/rules', { method: 'POST', body: JSON.stringify(rule) });
    upsertRuleInState(saved);
    renderRulesTable();
    $('#rule-dialog').close();
    toast('已保存');
    void loadRules({ quiet: true, force: true });
  } catch (err) {
    toast(err.message);
  } finally {
    setPending('rule:save', false);
    if (btn) { btn.disabled = false; btn.textContent = '保存'; }
  }
}

async function dryRunRule() {
  const btn = $('#rule-dryrun');
  if (isPending('rule:dryrun')) return;
  setPending('rule:dryrun', true);
  if (btn) { btn.disabled = true; btn.textContent = '运行中…'; }
  const rule = buildRuleFromForm();
  try {
    const res = await api('/api/rules/dry-run', { method: 'POST', body: JSON.stringify({ rule }) });
    const samples = (res.samples || []).map((s) =>
      `- ${s.event_id || 'event'} ${s.case_id ? `case=${s.case_id} ` : ''}${s.service || 'unknown'} ${s.caller || ''} ${short(s.msg || s.fingerprint || '', 120)}`,
    ).join('\n');
    $('#rule-dryrun-result').textContent = `预计命中：${res.hit_count || 0} 条最近事件\n\n样本：\n${samples || '暂无样本'}`;
    $('#rule-dryrun-result').classList.remove('hidden');
  } catch (e) {
    toast(e.message);
  } finally {
    setPending('rule:dryrun', false);
    if (btn) { btn.disabled = false; btn.textContent = 'Dry-run'; }
  }
}

async function deleteRule(id, button = null) {
  if (!await pluginConfirm('确认删除?')) return;
  const key = `rule:del:${id}`;
  if (isPending(key)) return;
  setPending(key, true);
  if (button) {
    button.disabled = true;
    button.textContent = '删除中…';
  }
  try {
    await api(`/api/rules/${id}`, { method: 'DELETE' });
    state.rules = state.rules.filter((r) => r.id !== id);
    renderRulesTable();
    toast('已删除');
    void loadRules({ quiet: true, force: true });
  } catch (e) {
    toast(e.message);
  } finally {
    setPending(key, false);
    if (button) {
      button.disabled = false;
      button.textContent = '删除';
    }
  }
}

async function loadFingerprintRules({ quiet = false, force = false } = {}) {
  if (!force && isFresh('fingerprints') && state.fingerprintRules.length) {
    renderFingerprintRulesTable();
    return;
  }
  const quietMode = quiet && hasPageData('fingerprints');
  if (quietMode) setRefreshing('fingerprints', true);
  else $('#fingerprints-loading')?.classList.remove('hidden');
  $('#fingerprints-error')?.classList.add('hidden');
  $('#fingerprints-empty')?.classList.add('hidden');
  try {
    const data = await runOnce('fingerprints', () => api('/api/fingerprint-rules'));
    state.fingerprintRules = data.items || [];
    $('#fingerprints-loading')?.classList.add('hidden');
    markRefresh('fingerprints');
    renderFingerprintRulesTable();
  } catch (e) {
    $('#fingerprints-loading')?.classList.add('hidden');
    $('#fingerprints-error').textContent = e.message;
    $('#fingerprints-error')?.classList.remove('hidden');
  } finally {
    setRefreshing('fingerprints', false);
  }
}

function renderFingerprintRulesTable() {
  if (!state.fingerprintRules.length) {
    $('#fingerprints-empty')?.classList.remove('hidden');
    $('#fingerprints-content')?.classList.add('hidden');
    return;
  }
  $('#fingerprints-empty')?.classList.add('hidden');
  $('#fingerprints-content')?.classList.remove('hidden');
  $('#fingerprints-table tbody').innerHTML = state.fingerprintRules.map((r) => {
    const scope = [r.environment || '全部环境', r.service || '全部服务'].join(' / ');
    return `
      <tr>
        <td>${esc(r.name)}</td>
        <td>${esc(scope)}</td>
        <td>${esc(fingerprintFieldLabel(r.match_field))}</td>
        <td><code class="mono">${esc(short(r.pattern || '', 72))}</code></td>
        <td><code class="mono">${esc(short(r.replacement || '', 48))}</code></td>
        <td>${r.priority ?? 100}</td>
        <td>${r.enabled ? '是' : '否'}</td>
        <td>${r.hit_count || 0}</td>
        <td class="row-actions">
          <button type="button" class="btn btn-sm" data-edit-fpr="${esc(r.id)}">编辑</button>
          <button type="button" class="btn btn-sm btn-secondary" data-del-fpr="${esc(r.id)}">删除</button>
        </td>
      </tr>`;
  }).join('');
  $$('#fingerprints-table [data-edit-fpr]').forEach((b) => b.addEventListener('click', () => editFingerprintRule(b.dataset.editFpr)));
  $$('#fingerprints-table [data-del-fpr]').forEach((b) => b.addEventListener('click', () => deleteFingerprintRule(b.dataset.delFpr, b)));
}

function fingerprintFieldLabel(field) {
  return ({
    msg: '消息',
    error: '错误',
    caller: '调用位置',
    function: '函数',
    path: '路径',
    fingerprint: '最终指纹',
  })[field] || field || '-';
}

function upsertFingerprintRuleInState(rule) {
  if (!rule?.id) return;
  const idx = state.fingerprintRules.findIndex((r) => r.id === rule.id);
  if (idx >= 0) state.fingerprintRules[idx] = rule;
  else state.fingerprintRules.unshift(rule);
}

function populateFingerprintServiceOptions() {
  const datalist = $('#fingerprint-service-options');
  if (!datalist) return;
  datalist.innerHTML = notificationRouteServiceOptions()
    .map((svc) => `<option value="${esc(svc)}"></option>`)
    .join('');
}

function editFingerprintRule(id) {
  const r = state.fingerprintRules.find((x) => x.id === id) || {};
  populateFingerprintServiceOptions();
  $('#fingerprint-rule-id').value = r.id || '';
  $('#fingerprint-rule-name').value = r.name || '';
  $('#fingerprint-rule-description').value = r.description || '';
  $('#fingerprint-rule-environment').value = r.environment || '';
  $('#fingerprint-rule-service').value = r.service || '';
  $('#fingerprint-rule-field').value = r.match_field || 'msg';
  $('#fingerprint-rule-priority').value = r.priority ?? 100;
  $('#fingerprint-rule-pattern').value = r.pattern || '';
  $('#fingerprint-rule-replacement').value = r.replacement || '';
  $('#fingerprint-rule-enabled').checked = r.enabled !== false;
  $('#fingerprint-rule-sample-a').value = '';
  $('#fingerprint-rule-sample-b').value = '';
  const sampleACaller = $('#fingerprint-rule-sample-a-caller');
  const sampleBCaller = $('#fingerprint-rule-sample-b-caller');
  if (sampleACaller) sampleACaller.value = '';
  if (sampleBCaller) sampleBCaller.value = '';
  $('#fingerprint-rule-preview-result')?.classList.add('hidden');
  syncFingerprintRuleFieldHint();
  $('#fingerprint-rule-dialog')?.showModal();
}

function syncFingerprintRuleFieldHint() {
  const isCaller = $('#fingerprint-rule-field')?.value === 'caller';
  $('#fingerprint-rule-caller-hint')?.classList.toggle('hidden', !isCaller);
  $('#fingerprint-rule-sample-callers')?.classList.toggle('hidden', !isCaller);
}

function buildFingerprintRuleFromForm() {
  return {
    id: $('#fingerprint-rule-id').value,
    name: $('#fingerprint-rule-name').value.trim(),
    description: $('#fingerprint-rule-description').value.trim(),
    environment: $('#fingerprint-rule-environment').value.trim(),
    service: $('#fingerprint-rule-service').value.trim(),
    match_field: $('#fingerprint-rule-field').value,
    pattern: $('#fingerprint-rule-pattern').value.trim(),
    replacement: $('#fingerprint-rule-replacement').value,
    priority: Number($('#fingerprint-rule-priority').value || 100),
    enabled: $('#fingerprint-rule-enabled').checked,
  };
}

function buildFingerprintPreviewSamples() {
  const service = $('#fingerprint-rule-service').value.trim();
  const environment = $('#fingerprint-rule-environment').value.trim() || 'prod';
  const rows = [
    {
      msg: $('#fingerprint-rule-sample-a').value,
      caller: $('#fingerprint-rule-sample-a-caller')?.value || '',
    },
    {
      msg: $('#fingerprint-rule-sample-b').value,
      caller: $('#fingerprint-rule-sample-b-caller')?.value || '',
    },
  ];
  return rows
    .map(({ msg, caller }) => ({ msg: msg.trim(), caller: caller.trim() }))
    .filter((row) => row.msg)
    .map((row) => {
      const sample = { environment, service, level: 'error', msg: row.msg };
      if (row.caller) sample.caller = row.caller;
      return sample;
    });
}

async function saveFingerprintRule(e) {
  e.preventDefault();
  const btn = $('#fingerprint-rule-save');
  if (isPending('fingerprint:save')) return;
  setPending('fingerprint:save', true);
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  const rule = buildFingerprintRuleFromForm();
  try {
    const saved = rule.id
      ? await api(`/api/fingerprint-rules/${rule.id}`, { method: 'PUT', body: JSON.stringify(rule) })
      : await api('/api/fingerprint-rules', { method: 'POST', body: JSON.stringify(rule) });
    upsertFingerprintRuleInState(saved);
    renderFingerprintRulesTable();
    $('#fingerprint-rule-dialog')?.close();
    const mergeMessage = fingerprintAutoMergeMessage(saved.auto_merge_result);
    showFingerprintAutoMergeResult(mergeMessage);
    toast(mergeMessage || '已保存');
    void loadFingerprintRules({ quiet: true, force: true });
  } catch (err) {
    toast(err.message);
  } finally {
    setPending('fingerprint:save', false);
    if (btn) { btn.disabled = false; btn.textContent = '保存'; }
  }
}

function fingerprintAutoMergeMessage(result) {
  if (!result) return '已保存';
  if (result.skipped_reason) return `已保存，未执行自动合并：${result.skipped_reason}`;
  const errors = result.errors || [];
  const scanned = result.scanned_events || 0;
  const recent = result.scanned_recent_events || 0;
  const active = result.scanned_active_case_events || 0;
  const scanText = `扫描 ${scanned} 条事件（最近 ${recent}，活跃 Case ${active}）`;
  if (result.merged_cases > 0) {
    const targetText = (result.target_cases || []).length ? `，目标 ${result.target_cases.join('、')}` : '';
    const errorText = errors.length ? `；${errors.length} 个合并失败` : '';
    return `已保存，${scanText}，命中 ${result.affected_events || 0} 条，自动合并 ${result.merged_cases} 个 Case（${result.merge_groups || 0} 组）${targetText}${errorText}`;
  }
  if (errors.length) return `已保存，自动合并失败：${errors.slice(0, 2).join('；')}`;
  if (result.normalized_cases > 0) {
    return `已保存，${scanText}，命中 ${result.affected_events || 0} 条，已更新 ${result.normalized_cases} 个活跃 Case 的归一化指纹，暂无需要合并的 Case`;
  }
  if (result.affected_events > 0) {
    return `已保存，${scanText}，命中 ${result.affected_events} 条，未发现需要合并的活跃 Case`;
  }
  return `已保存，${scanText}，规则未命中可合并 Case`;
}

function showFingerprintAutoMergeResult(message) {
  const el = $('#fingerprints-auto-merge-result');
  if (!el || !message) return;
  el.textContent = message;
  el.classList.remove('hidden');
}

async function previewFingerprintRule() {
  const rule = buildFingerprintRuleFromForm();
  const samples = buildFingerprintPreviewSamples();
  if (!samples.length) {
    toast('请先填写样本消息');
    return;
  }
  if (rule.match_field === 'caller') {
    if (samples.length < 2) {
      toast('caller 规则请填写样本 A 和样本 B 的消息');
      return;
    }
    if (samples.some((sample) => !sample.caller)) {
      toast('caller 规则预览请为两条样本都填写 caller');
      return;
    }
  }
  await runFingerprintRulePreview('/api/fingerprint-rules/preview', 'fingerprint:preview', $('#fingerprint-rule-preview'), { rule, samples });
}

async function dryRunFingerprintRule() {
  await runFingerprintRulePreview('/api/fingerprint-rules/dry-run', 'fingerprint:dryrun', $('#fingerprint-rule-dryrun'), { rule: buildFingerprintRuleFromForm() });
}

async function runFingerprintRulePreview(url, pendingKey, btn, body) {
  if (isPending(pendingKey)) return;
  setPending(pendingKey, true);
  const originalText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '运行中…'; }
  try {
    const res = await api(url, { method: 'POST', body: JSON.stringify(body) });
    $('#fingerprint-rule-preview-result').textContent = formatFingerprintPreviewResult(res);
    $('#fingerprint-rule-preview-result')?.classList.remove('hidden');
  } catch (e) {
    toast(e.message);
  } finally {
    setPending(pendingKey, false);
    if (btn) { btn.disabled = false; btn.textContent = originalText; }
  }
}

function formatFingerprintPreviewResult(res) {
  const headline = [
    `变化样本：${res.changed_count || 0}`,
    res.same_after ? '样本归并后相同' : '样本归并后仍不完全相同',
  ].join('；');
  const items = (res.items || []).map((item, idx) => {
    const sample = item.sample || {};
    return [
      `#${idx + 1} ${sample.event_id || sample.service || 'sample'} ${item.changed ? 'changed' : 'unchanged'}`,
      `before: ${item.before_fingerprint || '-'}`,
      `after : ${item.after_fingerprint || '-'}`,
      sample.caller ? `caller: ${sample.caller}` : '',
      sample.msg ? `msg   : ${short(sample.msg, 160)}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');
  return `${headline}\n\n${items || '暂无命中样本'}`;
}

async function deleteFingerprintRule(id, button = null) {
  if (!await pluginConfirm('确认删除这条指纹规则?')) return;
  const key = `fingerprint:del:${id}`;
  if (isPending(key)) return;
  setPending(key, true);
  if (button) {
    button.disabled = true;
    button.textContent = '删除中…';
  }
  try {
    await api(`/api/fingerprint-rules/${id}`, { method: 'DELETE' });
    state.fingerprintRules = state.fingerprintRules.filter((r) => r.id !== id);
    renderFingerprintRulesTable();
    toast('已删除');
  } catch (e) {
    toast(e.message);
  } finally {
    setPending(key, false);
    if (button) {
      button.disabled = false;
      button.textContent = '删除';
    }
  }
}

async function loadNotifications({ quiet = false, force = false } = {}) {
  if (!force && isFresh('notifications') && state.notificationChannels.length) {
    renderNotificationsPage();
    return;
  }
  const quietMode = quiet && hasPageData('notifications');
  if (quietMode) setRefreshing('notifications', true);
  else $('#notifications-loading')?.classList.remove('hidden');
  $('#notifications-error')?.classList.add('hidden');
  $('#notifications-content')?.classList.add('hidden');
  try {
    const [channels, policies, routes, deliveries] = await runOnce('notifications', async () => {
      const [ch, pol, rte, del] = await Promise.all([
        api('/api/notification-channels'),
        api('/api/notification-policies'),
        api('/api/service-notification-routes'),
        api('/api/notification-deliveries?limit=30'),
      ]);
      return [ch, pol, rte, del];
    });
    state.notificationChannels = channels.items || [];
    state.notificationPolicies = policies.items || [];
    state.notificationRoutes = routes.items || [];
    state.notificationDeliveries = deliveries.items || [];
    $('#notifications-loading')?.classList.add('hidden');
    markRefresh('notifications');
    renderNotificationsPage();
  } catch (e) {
    $('#notifications-loading')?.classList.add('hidden');
    $('#notifications-error').textContent = e.message;
    $('#notifications-error')?.classList.remove('hidden');
  } finally {
    setRefreshing('notifications', false);
  }
}

function renderNotificationRoutingHint() {
  const hint = $('#notification-routing-hint');
  if (!hint) return;
  const routeCount = state.notificationRoutes.filter((r) => r.enabled).length;
  const defaultPolicy = state.notificationPolicies
    .filter((p) => p.enabled && p.default)
    .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))[0];
  const parts = ['路由顺序：服务路由 → 默认策略 → legacy notify.wecom'];
  if (defaultPolicy) {
    parts.push(`当前默认策略：${defaultPolicy.name}`);
  } else {
    parts.push('当前无启用默认策略，未匹配服务走 legacy notify.wecom');
  }
  parts.push(`已配置 ${routeCount} 条启用服务路由`);
  hint.textContent = parts.join(' · ');
  hint.classList.toggle('warn', !defaultPolicy);
}

function renderNotificationsPage() {
  renderNotificationRoutingHint();
  fillNotificationRouteServiceOptions();
  const hasData = state.notificationChannels.length || state.notificationPolicies.length
    || state.notificationRoutes.length || state.notificationDeliveries.length;
  if (!hasData) {
    $('#notifications-empty')?.classList.remove('hidden');
    $('#notifications-content')?.classList.add('hidden');
    return;
  }
  $('#notifications-empty')?.classList.add('hidden');
  $('#notifications-content')?.classList.remove('hidden');
  $('#notification-channels-table tbody').innerHTML = state.notificationChannels.map((ch) => `
    <tr>
      <td>${esc(ch.name)}</td>
      <td>${badge(ch.channel_type)}</td>
      <td>${esc(ch.provider || '—')}</td>
      <td>${ch.enabled ? '是' : '否'}</td>
      <td>${ch.priority ?? 100}</td>
      <td class="row-actions">
        <button type="button" class="btn btn-sm" data-edit-channel="${esc(ch.id)}">编辑</button>
      </td>
    </tr>`).join('');
  $('#notification-policies-table tbody').innerHTML = state.notificationPolicies.map((p) => `
    <tr>
      <td>${esc(p.name)}</td>
      <td>${esc(short(p.description || '—', 48))}</td>
      <td>${(p.rules || []).length}</td>
      <td>${p.enabled ? '是' : '否'}</td>
      <td>${p.default ? '是' : '否'}</td>
      <td class="row-actions">
        <button type="button" class="btn btn-sm" data-edit-policy="${esc(p.id)}">编辑</button>
      </td>
    </tr>`).join('');
  $('#notification-routes-table tbody').innerHTML = state.notificationRoutes.map((r) => `
    <tr>
      <td>${esc(displayService(r.service))}</td>
      <td>${esc(r.policy_name || r.policy_id || '—')}</td>
      <td>${r.enabled ? '是' : '否'}</td>
      <td class="row-actions">
        <button type="button" class="btn btn-sm" data-edit-route="${esc(r.id)}">编辑</button>
      </td>
    </tr>`).join('');
  $('#notification-deliveries-table tbody').innerHTML = state.notificationDeliveries.map((d) => `
    <tr>
      <td title="${esc(fmtTime(d.created_at))}">${esc(fmtAge(d.created_at))}</td>
      <td class="mono">${esc(short(d.case_id || '—', 16))}</td>
      <td>${esc(d.policy_name || '—')}</td>
      <td>${badge(d.channel_type || '—')}</td>
      <td>${badge(d.status)}</td>
      <td title="${esc(d.error || '')}">${esc(short(d.error || '—', 48))}</td>
    </tr>`).join('');
  $$('#notification-channels-table [data-edit-channel]').forEach((b) => b.addEventListener('click', () => editNotificationChannel(b.dataset.editChannel)));
  $$('#notification-policies-table [data-edit-policy]').forEach((b) => b.addEventListener('click', () => editNotificationPolicy(b.dataset.editPolicy)));
  $$('#notification-routes-table [data-edit-route]').forEach((b) => b.addEventListener('click', () => editNotificationRoute(b.dataset.editRoute)));
}

function editNotificationChannel(id) {
  const ch = state.notificationChannels.find((x) => x.id === id) || {};
  $('#notification-channel-id').value = ch.id || '';
  $('#notification-channel-name').value = ch.name || '';
  $('#notification-channel-type').value = ch.channel_type || 'wecom_group';
  $('#notification-channel-provider').value = 'wecom';
  $('#notification-channel-target').value = ch.target || '';
  $('#notification-channel-priority').value = ch.priority ?? 100;
  $('#notification-channel-enabled').checked = ch.enabled !== false;
  $('#notification-channel-dialog').showModal();
}

function buildNotificationChannelFromForm() {
  return {
    id: $('#notification-channel-id').value,
    name: $('#notification-channel-name').value.trim(),
    channel_type: $('#notification-channel-type').value,
    provider: $('#notification-channel-provider').value.trim(),
    target: $('#notification-channel-target').value.trim(),
    priority: Number($('#notification-channel-priority').value || 100),
    enabled: $('#notification-channel-enabled').checked,
  };
}

async function saveNotificationChannel(e) {
  e.preventDefault();
  const btn = $('#notification-channel-save');
  if (isPending('notification-channel:save')) return;
  setPending('notification-channel:save', true);
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  const channel = buildNotificationChannelFromForm();
  try {
    const saved = channel.id
      ? await api(`/api/notification-channels/${channel.id}`, { method: 'PUT', body: JSON.stringify(channel) })
      : await api('/api/notification-channels', { method: 'POST', body: JSON.stringify(channel) });
    const idx = state.notificationChannels.findIndex((c) => c.id === saved.id);
    if (idx >= 0) state.notificationChannels[idx] = saved;
    else state.notificationChannels.unshift(saved);
    renderNotificationsPage();
    $('#notification-channel-dialog').close();
    toast('渠道已保存');
    void loadNotifications({ quiet: true, force: true });
  } catch (err) {
    toast(err.message);
  } finally {
    setPending('notification-channel:save', false);
    if (btn) { btn.disabled = false; btn.textContent = '保存'; }
  }
}

function fillNotificationPolicyChannelSelect(value = '') {
  const select = $('#notification-policy-channel');
  if (!select) return;
  if (!state.notificationChannels.length) {
    select.innerHTML = '<option value="">先创建通知渠道</option>';
    select.value = '';
    return;
  }
  select.innerHTML = state.notificationChannels.map((ch) =>
    `<option value="${esc(ch.id)}">${esc(ch.name)} · ${esc(ch.channel_type)}</option>`).join('');
  select.value = value || state.notificationChannels[0]?.id || '';
}

function editNotificationPolicy(id) {
  const policy = state.notificationPolicies.find((x) => x.id === id) || {};
  const rule = (policy.rules || [])[0] || {};
  $('#notification-policy-id').value = policy.id || '';
  $('#notification-policy-rule-id').value = rule.id || '';
  $('#notification-policy-name').value = policy.name || '';
  $('#notification-policy-description').value = policy.description || '';
  $('#notification-policy-rule-priority').value = rule.priority ?? 100;
  setSelectOptionValue('#notification-policy-severity', rule.severity_filter || '');
  setSelectOptionValue('#notification-policy-status', rule.status_filter || '');
  setSelectOptionValue('#notification-policy-reason', rule.reason_filter || '');
  $('#notification-policy-enabled').checked = policy.enabled !== false;
  $('#notification-policy-default').checked = Boolean(policy.default);
  fillNotificationPolicyChannelSelect(rule.channel_id || '');
  $('#notification-policy-dialog').showModal();
}

function openNewNotificationPolicy() {
  editNotificationPolicy('');
  $('#notification-policy-id').value = '';
  $('#notification-policy-rule-id').value = '';
}

function buildNotificationPolicyFromForm() {
  const channelID = $('#notification-policy-channel').value;
  return {
    id: $('#notification-policy-id').value,
    name: $('#notification-policy-name').value.trim(),
    description: $('#notification-policy-description').value.trim(),
    enabled: $('#notification-policy-enabled').checked,
    default: $('#notification-policy-default').checked,
    rules: channelID ? [{
      id: $('#notification-policy-rule-id').value,
      channel_id: channelID,
      severity_filter: $('#notification-policy-severity').value.trim(),
      status_filter: $('#notification-policy-status').value.trim(),
      reason_filter: $('#notification-policy-reason').value.trim(),
      enabled: true,
      priority: Number($('#notification-policy-rule-priority').value || 100),
    }] : [],
  };
}

async function saveNotificationPolicy(e) {
  e.preventDefault();
  const btn = $('#notification-policy-save');
  if (isPending('notification-policy:save')) return;
  const policy = buildNotificationPolicyFromForm();
  if (!policy.rules.length) {
    toast('请先选择通知渠道');
    return;
  }
  setPending('notification-policy:save', true);
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  try {
    const saved = policy.id
      ? await api(`/api/notification-policies/${policy.id}`, { method: 'PUT', body: JSON.stringify(policy) })
      : await api('/api/notification-policies', { method: 'POST', body: JSON.stringify(policy) });
    const idx = state.notificationPolicies.findIndex((p) => p.id === saved.id);
    if (idx >= 0) state.notificationPolicies[idx] = saved;
    else state.notificationPolicies.unshift(saved);
    renderNotificationsPage();
    $('#notification-policy-dialog').close();
    toast('策略已保存');
    void loadNotifications({ quiet: true, force: true });
  } catch (err) {
    toast(err.message);
  } finally {
    setPending('notification-policy:save', false);
    if (btn) { btn.disabled = false; btn.textContent = '保存'; }
  }
}

function editNotificationRoute(id) {
  const route = state.notificationRoutes.find((x) => x.id === id) || {};
  $('#notification-route-id').value = route.id || '';
  $('#notification-route-service').value = route.service || '';
  $('#notification-route-enabled').checked = route.enabled !== false;
  fillNotificationRouteServiceOptions();
  fillNotificationRoutePolicySelect(route.policy_id || '');
  $('#notification-route-dialog').showModal();
}

function notificationRouteServiceOptions() {
  const options = new Set();
  const caseOptions = state.filterOptions?.case || {};
  const eventOptions = state.filterOptions?.event || {};
  [...(caseOptions.services || []), ...(eventOptions.services || [])].forEach((service) => {
    if (service) options.add(service);
  });
  state.notificationRoutes.forEach((route) => {
    if (route.service) options.add(route.service);
  });
  state.owners.forEach((owner) => {
    if (owner.service) options.add(owner.service);
  });
  return [...options].sort((a, b) => a.localeCompare(b));
}

function fillNotificationRouteServiceOptions() {
  const datalist = $('#notification-route-service-options');
  if (!datalist) return;
  datalist.innerHTML = notificationRouteServiceOptions()
    .map((service) => `<option value="${esc(service)}">${esc(displayService(service))}</option>`)
    .join('');
}

function fillNotificationRoutePolicySelect(value = '') {
  const select = $('#notification-route-policy');
  if (!select) return;
  if (!state.notificationPolicies.length) {
    select.innerHTML = '<option value="">先创建通知策略</option>';
    select.value = '';
    return;
  }
  select.innerHTML = '<option value="">请选择通知策略</option>' + state.notificationPolicies.map((p) => {
    const suffix = p.default ? ' · 默认' : '';
    return `<option value="${esc(p.id)}">${esc(p.name)}${suffix}</option>`;
  }).join('');
  select.value = value || '';
}

function openNewNotificationChannel() {
  editNotificationChannel('');
  $('#notification-channel-id').value = '';
}

function openNewNotificationRoute() {
  editNotificationRoute('');
  $('#notification-route-id').value = '';
  $('#notification-route-service').value = '';
  fillNotificationRoutePolicySelect('');
}

async function saveNotificationRoute(e) {
  e.preventDefault();
  const btn = $('#notification-route-save');
  if (isPending('notification-route:save')) return;
  setPending('notification-route:save', true);
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  try {
    const serviceName = $('#notification-route-service').value.trim();
    if (!serviceName) throw new Error('请先填写服务');
    const routeID = $('#notification-route-id').value;
    const selectedPolicyID = $('#notification-route-policy').value;
    const policy = state.notificationPolicies.find((p) => p.id === selectedPolicyID);
    if (!policy?.id) throw new Error('请选择通知策略');
    const route = {
      id: routeID,
      service: serviceName,
      policy_id: policy.id,
      enabled: $('#notification-route-enabled').checked,
    };
    const saved = route.id
      ? await api(`/api/service-notification-routes/${route.id}`, { method: 'PUT', body: JSON.stringify(route) })
      : await api('/api/service-notification-routes', { method: 'POST', body: JSON.stringify(route) });
    const idx = state.notificationRoutes.findIndex((r) => r.id === saved.id);
    if (idx >= 0) state.notificationRoutes[idx] = saved;
    else state.notificationRoutes.unshift(saved);
    renderNotificationsPage();
    $('#notification-route-dialog').close();
    toast('服务路由已保存');
    void loadNotifications({ quiet: true, force: true });
  } catch (err) {
    toast(err.message);
  } finally {
    setPending('notification-route:save', false);
    if (btn) { btn.disabled = false; btn.textContent = '保存'; }
  }
}

async function submitIngest() {
  const body = $('#ingest-body').value.trim();
  if (!body) return;
  const btn = $('#ingest-submit');
  if (isPending('ingest')) return;
  setPending('ingest', true);
  if (btn) { btn.disabled = true; btn.textContent = '导入中…'; }
  const ingestType = $('#ingest-type').value || 'tencent-cls';
  const endpoint = ingestType === 'generic' ? '/api/ingest/generic' : '/api/ingest/tencent-cls';
  $('#ingest-loading').classList.remove('hidden');
  $('#ingest-error').classList.add('hidden');
  $('#ingest-success').classList.add('hidden');
  $('#ingest-result-wrap').classList.add('hidden');
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-ID': userId() },
      body,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    $('#ingest-loading').classList.add('hidden');
    $('#ingest-success').textContent = `导入成功：${data.stored_events} 事件，新建 ${data.cases_created} case，更新 ${data.cases_updated}，抑制 ${data.suppressed}`;
    $('#ingest-success').classList.remove('hidden');
    $('#ingest-result').textContent = JSON.stringify(data, null, 2);
    $('#ingest-result-wrap').classList.remove('hidden');
    markRefresh('ingest');
  } catch (e) {
    $('#ingest-loading').classList.add('hidden');
    $('#ingest-error').textContent = e.message;
    $('#ingest-error').classList.remove('hidden');
  } finally {
    setPending('ingest', false);
    if (btn) { btn.disabled = false; btn.textContent = '导入'; }
  }
}

async function loadSample() {
  const ingestType = $('#ingest-type').value || 'tencent-cls';
  const samplePath = ingestType === 'generic' ? '/samples/generic-alert.json' : '/samples/tencent-cls.ndjson';
  try {
    const res = await fetch(samplePath);
    if (!res.ok) throw new Error('sample not found');
    $('#ingest-body').value = await res.text();
  } catch {
    if (ingestType === 'generic') {
      $('#ingest-body').value = JSON.stringify({
        source: 'prometheus',
        source_type: 'alertmanager',
        external_id: 'alert-demo-1',
        service: 'goods-http',
        environment: 'prod',
        severity: 'critical',
        title: 'High error rate',
        message: '5xx > 5%',
        fingerprint: 'demo-generic-fp',
        labels: { team: 'goods' },
      }, null, 2);
    } else {
      toast('无法加载样例文件，请手动粘贴');
    }
  }
}

function init() {
  renderSidebar();
  bindNavEvents();

  const saved = localStorage.getItem('alert-hub-user');
  if (saved && $('#user-id')) $('#user-id').value = saved;
  $('#user-id')?.addEventListener('change', (e) => {
    localStorage.setItem('alert-hub-user', e.target.value);
    loadMe();
  });
  $('#login-form')?.addEventListener('submit', submitLogin);
  $('#logout-btn')?.addEventListener('click', logout);
  $('#change-password-btn')?.addEventListener('click', openPasswordDialog);
  $('#password-form')?.addEventListener('submit', submitPasswordChange);
  $('#password-cancel')?.addEventListener('click', () => $('#password-dialog')?.close());
  $$('[data-goto-page]').forEach((b) => {
    b.addEventListener('click', () => showPage(b.dataset.gotoPage));
  });
  $('#global-refresh')?.addEventListener('click', refreshCurrentPage);
  $('#dashboard-refresh')?.addEventListener('click', () => loadDashboard({ force: true, quiet: hasPageData('dashboard') }));
  $('#dashboard-reset')?.addEventListener('click', resetDashboardFilters);
  $$('#dashboard-trend-mode [data-trend-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.dashboardTrendMode = btn.dataset.trendMode || 'volume';
      renderTrendChart(state.dashboard?.trends || []);
    });
  });
  [
    '#dashboard-scope',
    '#dashboard-range',
    '#dashboard-team',
    '#dashboard-service',
    '#dashboard-severity',
    '#dashboard-assignee',
    '#dashboard-env',
  ].forEach((selector) => $(selector)?.addEventListener('change', () => loadDashboard({ force: true, quiet: hasPageData('dashboard') })));
  $('#case-filter').addEventListener('click', () => {
    clearCaseRiskFilter();
    loadCases({ force: true, quiet: hasPageData('cases') });
  });
  [
    '#case-view',
    '#case-scope',
    '#case-status',
    '#case-service',
    '#case-severity',
    '#case-assignee',
    '#case-env',
  ].forEach((selector) => $(selector)?.addEventListener('change', () => {
    clearCaseRiskFilter();
    loadCases({ force: true, quiet: hasPageData('cases') });
  }));
  $('#case-q')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearCaseRiskFilter();
      loadCases({ force: true, quiet: hasPageData('cases') });
    }
  });
  $('#cases-load-more')?.addEventListener('click', () => loadCases({ append: true }));
  $('#case-export')?.addEventListener('click', exportCases);
  $('#event-filter')?.addEventListener('click', () => loadEvents({ force: true, quiet: hasPageData('events') }));
  $('#event-export')?.addEventListener('click', exportEvents);
  $$('[data-time-target]').forEach((btn) => {
    btn.addEventListener('click', () => {
      applyTimeRangePreset(btn.dataset.timeTarget, btn.dataset.timeRange || '');
    });
  });
  ['#case-from', '#case-to'].forEach((selector) => $(selector)?.addEventListener('change', () => {
    clearCaseRiskFilter();
    loadCases({ force: true, quiet: hasPageData('cases') });
  }));
  ['#event-from', '#event-to'].forEach((selector) => $(selector)?.addEventListener('change', () => {
    loadEvents({ force: true, quiet: hasPageData('events') });
  }));
  [
    '#event-service',
    '#event-env',
    '#event-suppressed',
  ].forEach((selector) => $(selector)?.addEventListener('change', () => loadEvents({ force: true, quiet: hasPageData('events') })));
  $('#event-q')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadEvents({ force: true, quiet: hasPageData('events') });
  });
  $('#event-case-id')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadEvents({ force: true, quiet: hasPageData('events') });
  });
  $('#events-load-more')?.addEventListener('click', () => loadEvents({ append: true }));
  $('#case-todo-form').addEventListener('submit', createCaseTodo);
  $('#merge-form')?.addEventListener('submit', submitCaseMerge);
  $$('#case-detail-tabs [data-detail-tab]').forEach((btn) => {
    btn.addEventListener('click', () => setCaseDetailTab(btn.dataset.detailTab));
  });
  $('#severity-form')?.addEventListener('submit', submitSeverity);
  $('#assign-form')?.addEventListener('submit', submitAssign);
  $('#triage-form')?.addEventListener('submit', (e) => submitTriage(e, 'triaged'));
  $('#triage-fixing-btn')?.addEventListener('click', (e) => submitTriage(e, 'fixing'));
  $('#todo-filter').addEventListener('click', () => loadTodos({ force: true, quiet: hasPageData('todos') }));
  $('#todos-load-more')?.addEventListener('click', () => loadTodos({ append: true }));
  $$('#case-quick-filters .chip').forEach((chip) => {
    chip.addEventListener('click', () => applyQuickFilter(chip.dataset.quick));
  });
  $$('.metric-drilldown').forEach((btn) => {
    btn.addEventListener('click', () => drillDownFromKPI(btn.dataset.kpi));
    btn.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      drillDownFromKPI(btn.dataset.kpi);
    });
  });
  $('#close-detail').addEventListener('click', () => {
    $('#case-detail').classList.add('hidden');
    $('#cases-content').classList.remove('has-detail');
    state.currentCaseId = null;
    $$('#cases-table tbody tr').forEach((tr) => tr.classList.remove('selected'));
  });
  $('#comment-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = $('#comment-body').value.trim();
    const id = state.currentCaseId;
    if (!id || !body) return;
    const btn = $('#comment-submit');
    if (isPending('comment')) return;
    setPending('comment', true);
    if (btn) { btn.disabled = true; btn.textContent = '提交中…'; }
    try {
      const updated = await api(`/api/cases/${id}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
      $('#comment-body').value = '';
      if (state.currentCaseId === id) renderCaseDetail(updated);
      renderCasesTable();
      void loadCases({ quiet: true, force: true });
    } catch (err) {
      toast(err.message);
    } finally {
      setPending('comment', false);
      if (btn) { btn.disabled = false; btn.textContent = '提交评论'; }
    }
  });
  $('#owner-new').addEventListener('click', () => openOwnerDialog());
  $('#owner-open-people')?.addEventListener('click', () => showPage('people'));
  $('#owner-primary')?.addEventListener('input', syncOwnerDerivedFields);
  $('#owner-backup')?.addEventListener('input', syncOwnerDerivedFields);
  for (const prefix of ['owner', 'person']) {
    $(`#${prefix}-team`).addEventListener('change', () => {
      if (prefix === 'owner') {
        ownerAutoTeam = false;
        syncOwnerDerivedFields();
      }
      updateTeamFreeField(prefix);
    });
    if (prefix === 'owner') {
      $(`#${prefix}-team-free`).addEventListener('input', () => {
        ownerAutoTeam = false;
        syncOwnerDerivedFields();
      });
    }
  }
  $('#owner-team-follow')?.addEventListener('click', restoreOwnerTeamFollow);
  $('#owner-form').addEventListener('submit', saveOwner);
  $('#owner-cancel').addEventListener('click', () => $('#owner-dialog').close());
  $('#person-new')?.addEventListener('click', () => openPersonDialog());
  $('#person-form')?.addEventListener('submit', savePerson);
  $('#person-cancel')?.addEventListener('click', () => $('#person-dialog').close());
  $('#team-new')?.addEventListener('click', () => openTeamDialog());
  $('#team-form')?.addEventListener('submit', saveTeam);
  $('#team-cancel')?.addEventListener('click', () => $('#team-dialog')?.close());
  ['#team-manage-mode', '#team-merge-target'].forEach(selector => $(selector).addEventListener('change', () => {
    $('#team-manage-confirm').checked = false;
    updateTeamManagement();
  }));
  $('#team-manage-confirm').addEventListener('change', updateTeamManagement);
  $('#team-manage-form').addEventListener('submit', submitTeamManagement);
  $('#team-manage-close').addEventListener('click', () => $('#team-manage-dialog').close());
  $('#team-manage-retry').addEventListener('click', () => openTeamManagement(teamManagement.id));
  $('#team-manage-dialog').addEventListener('cancel', e => { if (isPending('team:manage')) e.preventDefault(); });
  $('#rule-new').addEventListener('click', () => editRule(''));
  $('#rule-form').addEventListener('submit', saveRule);
  $('#rule-cancel').addEventListener('click', () => $('#rule-dialog').close());
  $('#rule-dryrun').addEventListener('click', dryRunRule);
  $('#fingerprint-refresh')?.addEventListener('click', () => loadFingerprintRules({ force: true, quiet: hasPageData('fingerprints') }));
  $('#fingerprint-rule-new')?.addEventListener('click', () => editFingerprintRule(''));
  $('#fingerprint-rule-field')?.addEventListener('change', syncFingerprintRuleFieldHint);
  $('#fingerprint-rule-form')?.addEventListener('submit', saveFingerprintRule);
  $('#fingerprint-rule-cancel')?.addEventListener('click', () => $('#fingerprint-rule-dialog')?.close());
  $('#fingerprint-rule-preview')?.addEventListener('click', previewFingerprintRule);
  $('#fingerprint-rule-dryrun')?.addEventListener('click', dryRunFingerprintRule);
  $('#diagnostics-refresh')?.addEventListener('click', () => loadDiagnostics({ force: true, quiet: hasPageData('diagnostics') }));
  $('#notification-channel-new')?.addEventListener('click', openNewNotificationChannel);
  $('#notification-policy-new')?.addEventListener('click', openNewNotificationPolicy);
  $('#notification-route-new')?.addEventListener('click', openNewNotificationRoute);
  $('#notification-channel-form')?.addEventListener('submit', saveNotificationChannel);
  $('#notification-channel-cancel')?.addEventListener('click', () => $('#notification-channel-dialog')?.close());
  $('#notification-policy-form')?.addEventListener('submit', saveNotificationPolicy);
  $('#notification-policy-cancel')?.addEventListener('click', () => $('#notification-policy-dialog')?.close());
  $('#notification-route-form')?.addEventListener('submit', saveNotificationRoute);
  $('#notification-route-cancel')?.addEventListener('click', () => $('#notification-route-dialog')?.close());
  $('#notifications-refresh')?.addEventListener('click', () => loadNotifications({ force: true, quiet: hasPageData('notifications') }));
  $('#ingest-submit').addEventListener('click', submitIngest);
  $('#ingest-load-sample').addEventListener('click', loadSample);
  $('#reclassify-services')?.addEventListener('click', reclassifyServices);

  checkAuth().then(async (ok) => {
    if (ok) {
      await loadMe();
      await loadFilterOptions();
      openInitialRoute();
    }
  });
}

init();
