'use strict';

/* 冷链温控与批次放行台 —— 原生 JS，无框架、无构建、无外部依赖。
   显示纪律：超限段、断链、MKT、放行判定、各类计数一律直接显示接口返回值，前端不自行计算与重排。 */

const RECORD_PAGE = 200;
const BATCH_STATUS = ['在库', '待放行', '已放行', '已拒收'];
const ROOM_STATUS = ['运行', '检修', '停用'];
const ROOM_TYPE = ['冷藏库', '冷藏车', '冷冻库'];
const PROBE_STATUS = ['在用', '停用', '送检'];
const SOURCE_LIST = ['自动', '人工'];
const ATTR_STATUS = ['明确', '重叠裁得', '账外归他', '存疑'];

const OVERLAP_POLICY_OPTIONS = [
  { value: 'midpoint', label: '中点切分：重叠时段按先后均分，各算各的' },
  { value: 'firstWins', label: '先占者全得：整段重叠归先占用的批次' },
  { value: 'suspend', label: '整段挂起：重叠记录双方都不判，全部标存疑' }
];
const BOUNDARY_OPTIONS = [
  { value: 'leftClosed', label: '左闭右开：切点/交接时刻归先占用的批次' },
  { value: 'rightClosed', label: '左开右闭：切点/交接时刻归后占用的批次' }
];
const TIE_BASIS_OPTIONS = [
  { value: 'occupyStart', label: '占用开始时刻（占用账上谁先登谁占先）' },
  { value: 'loadedAt', label: '批次入库时刻（谁先入库谁占先）' },
  { value: 'recordFirst', label: '最早记录时刻（该探头上谁先有记录谁占先）' }
];
const TIMELINE_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'];

const state = {
  view: 'overview',
  summary: null,
  settings: null,
  rooms: [],
  probes: [],
  batches: [],
  batchesView: [],
  recordsView: [],
  releasesView: [],
  ledger: { occupancies: [], devices: [], policy: null },
  roomDetail: {},
  batchDetail: {},
  batchOut: {},
  batchDetailError: {},
  expandedRooms: new Set(),
  expandedBatches: new Set(),
  filters: {
    rooms: { status: '', type: '', keyword: '', probeStatus: '', probeCal: 'all' },
    batches: { status: '', roomId: '', product: '', noRecord: false },
    ledger: { roomId: '', probeId: '', batchId: '' },
    records: { batchId: '', probeId: '', source: '', attribution: '', from: '', to: '' },
    releases: { decision: '' }
  }
};

/* ---------- 基础工具 ---------- */

function $(id) { return document.getElementById(id); }

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/* 接口报错统一是 {error:{code,message,details}}，这里把它抛成普通对象保留 details */
async function api(method, path, body) {
  const opts = { method: method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const raw = await res.text();
  let data = null;
  if (raw) { try { data = JSON.parse(raw); } catch (e) { data = null; } }
  if (!res.ok) {
    const err = (data && data.error) ? data.error : { code: 'HTTP_' + res.status, message: '请求失败（' + res.status + '）', details: null };
    throw { code: err.code, message: err.message, details: err.details, status: res.status };
  }
  return data;
}

let errorTimer = null;
function showError(err) {
  const banner = $('errorBanner');
  let msg = (err && err.message) ? err.message : '出错了';
  if (err && err.details && typeof err.details === 'object' && !Array.isArray(err.details)) {
    const parts = Object.keys(err.details).map(function (k) { return k + '：' + err.details[k]; });
    if (parts.length) msg += '（' + parts.join('；') + '）';
  }
  banner.textContent = msg;
  banner.hidden = false;
  if (errorTimer) clearTimeout(errorTimer);
  errorTimer = setTimeout(function () { banner.hidden = true; }, 7000);
  markErrorFields(err && err.details);
}

function markErrorFields(details) {
  document.querySelectorAll('.field-error').forEach(function (n) { n.classList.remove('field-error'); });
  if (!details || typeof details !== 'object' || Array.isArray(details)) return;
  Object.keys(details).forEach(function (k) {
    const input = document.querySelector('[data-field="' + k + '"]');
    if (input) {
      const wrap = input.closest('.field');
      if (wrap) wrap.classList.add('field-error');
    }
  });
}

function pill(text, cls) {
  return '<span class="pill ' + (cls || '') + '">' + esc(text) + '</span>';
}

function okPill(ok) {
  return ok ? pill('满足', 'pill-ok') : pill('不满足', 'pill-bad');
}

function attrPill(status) {
  if (status === '明确') return pill('明确', 'pill-mute');
  if (status === '重叠裁得') return pill('重叠裁得', 'pill-info');
  if (status === '账外归他') return pill('账外归他', 'pill-warn');
  if (status === '存疑') return pill('存疑', 'pill-bad');
  return pill(status || '—', 'pill-mute');
}

const ATTR_REASON_TEXT = {
  'sole-occupant': '该时段探头只挂着这一个批次',
  'device-level': '该时段只有这一个批次占着设备',
  'overlap-awarded': '重叠时段按口径裁给本批',
  'overlap-awarded-other': '重叠时段按口径裁给了别的批次',
  'mis-tagged': '该时段探头被别的批次占用',
  'mis-tagged-device': '该时段设备被别的批次占用',
  'overlap-suspended': '口径为整段挂起，重叠记录双方都不判',
  'overlap-undecidable': '重叠时段切不开，数据不足',
  'same-instant-conflict': '同一探头同一时刻挂了不同批次的两条读数，数据本身拆不开',
  'no-occupancy': '该时段没有任何占用记录，探头无主',
  'device-ambiguous': '该时段多个批次共用设备、未登记探头归属'
};

function attrReasonText(reason) { return ATTR_REASON_TEXT[reason] || reason || ''; }

function policyLabel(list, value) {
  const hit = list.find(function (o) { return o.value === value; });
  return hit ? hit.label : value;
}

function roomOptions(selected) {
  return ['<option value="">请选择冷库</option>'].concat(state.rooms.map(function (r) {
    return '<option value="' + esc(r.id) + '"' + (r.id === selected ? ' selected' : '') + '>' + esc(r.code + ' ' + r.name) + '</option>';
  })).join('');
}

function batchOptions(selected) {
  return ['<option value="">请选择批次</option>'].concat(state.batches.map(function (b) {
    return '<option value="' + esc(b.id) + '"' + (b.id === selected ? ' selected' : '') + '>' + esc(b.code + ' ' + b.product) + '</option>';
  })).join('');
}

function probeOptions(selected) {
  return ['<option value="">请选择探头</option>'].concat(state.probes.map(function (p) {
    return '<option value="' + esc(p.id) + '"' + (p.id === selected ? ' selected' : '') + '>' + esc(p.code + '（' + (p.roomCode || '') + '）') + '</option>';
  })).join('');
}

/* ---------- 弹层 ---------- */

let modalOnOk = null;

function openModal(title, bodyHtml, okText, onOk) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = bodyHtml;
  $('modalOk').textContent = okText || '保存';
  modalOnOk = onOk || null;
  $('modalMask').hidden = false;
  const first = $('modalBody').querySelector('input,select,textarea');
  if (first) setTimeout(function () { first.focus(); }, 20);
}

function closeModal() {
  $('modalMask').hidden = true;
  modalOnOk = null;
  $('modalBody').innerHTML = '';
  markErrorFields(null);
}

function formValues() {
  const out = {};
  $('modalBody').querySelectorAll('[data-field]').forEach(function (n) { out[n.dataset.field] = n.value; });
  return out;
}

/* 删除两步确认：第一次点把按钮变成「确认删除」，再点一次才真正执行 */
function armDelete(btn, fn) {
  armButton(btn, '确认删除', '删除', fn);
}

/* 通用两步确认：第一次点改文案，再点一次执行 */
function armButton(btn, armedText, idleText, fn) {
  if (btn.dataset.armed === '1') {
    btn.dataset.armed = '0';
    btn.classList.remove('armed');
    btn.textContent = idleText;
    fn();
    return;
  }
  btn.dataset.armed = '1';
  btn.classList.add('armed');
  btn.textContent = armedText;
  if (btn._armTimer) clearTimeout(btn._armTimer);
  btn._armTimer = setTimeout(function () {
    btn.dataset.armed = '0';
    btn.classList.remove('armed');
    btn.textContent = idleText;
  }, 4000);
}

/* ---------- 标签与视图切换 ---------- */

async function switchView(view) {
  state.view = view;
  document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('is-active', t.dataset.view === view); });
  document.querySelectorAll('.view').forEach(function (v) { v.classList.toggle('is-active', v.dataset.view === view); });
  renderFilters();
  await loadView(view);
}

async function loadView(view) {
  try {
    if (view === 'overview') await loadOverview();
    else if (view === 'rooms') await loadRoomsView();
    else if (view === 'batches') await loadBatchesView();
    else if (view === 'ledger') await loadLedgerView();
    else if (view === 'records') await loadRecordsView();
    else if (view === 'releases') await loadReleasesView();
  } catch (err) { showError(err); }
}

/* ---------- 概览 ---------- */

async function loadOverview() {
  const s = await api('GET', '/api/summary');
  state.summary = s;
  $('todayText').textContent = s.today;
  renderOverview();
}

function statusSummaryText(sc) {
  return BATCH_STATUS.map(function (k) { return k + ' ' + num(sc[k]); }).join(' / ');
}

function renderOverview() {
  const s = state.summary;
  if (!s) return;
  const sc = s.statusCount || {};
  const cards = [
    { title: '冷库', value: s.roomCount, sub: '运行中 ' + s.runningRoomCount, go: { view: 'rooms' } },
    { title: '探头', value: s.probeCount, sub: '在用 ' + s.runningProbeCount, go: { view: 'rooms' } },
    { title: '已过校准期探头', value: s.expiredProbeCount, sub: '需送检', go: { view: 'rooms', probeCal: 'expired' } },
    { title: '批次', value: s.batchCount, sub: statusSummaryText(sc), go: { view: 'batches' } },
    { title: '在办批次', value: s.openBatchCount, sub: '在库与待放行', go: { view: 'batches' } },
    { title: '温度记录', value: s.recordCount, sub: '人工 ' + s.manualRecordCount, go: { view: 'records' } },
    { title: '放行 / 拒收', value: s.releasedCount + ' / ' + s.rejectedCount, sub: '台账 ' + s.releaseCount + ' 条', go: { view: 'releases' } },
    { title: '满足放行条件', value: s.readyToRelease, sub: '被挡下 ' + s.blockedCount, go: { view: 'batches' } },
    { title: '没有温度记录', value: s.noRecordBatches, sub: '个批次', go: { view: 'batches', noRecord: true } },
    { title: '归属存疑记录', value: s.unresolvedRecordCount, sub: '重叠窗 ' + s.occupancyOverlapCount + ' 个', go: { view: 'ledger' } },
    { title: 'MKT', value: s.maxMkt, sub: '平均 ' + s.averageMkt, go: { view: 'batches' } }
  ];
  $('overviewCards').innerHTML = cards.map(function (c) {
    return '<div class="card" data-action="card-go" data-go=\'' + JSON.stringify(c.go) + '\'>' +
      '<div class="card-title">' + esc(c.title) + '</div>' +
      '<div class="card-value">' + esc(c.value) + '</div>' +
      '<div class="card-sub">' + esc(c.sub) + '</div>' +
      '</div>';
  }).join('');

  const rows = (s.rooms || []).map(function (r) {
    return '<tr class="row-main" data-rowkind="overview-room" data-id="' + esc(r.id) + '" data-action="goto-room" data-room-id="' + esc(r.id) + '">' +
      '<td>' + esc(r.code) + '</td>' +
      '<td>' + esc(r.name) + '</td>' +
      '<td>' + esc(r.type) + '</td>' +
      '<td>' + esc(r.status) + '</td>' +
      '<td class="num">' + num(r.probeCount) + '</td>' +
      '<td class="num">' + num(r.batchCount) + '</td>' +
      '<td class="num">' + num(r.openBatchCount) + '</td>' +
      '</tr>';
  }).join('');
  $('overviewRows').innerHTML = rows;
}

/* ---------- 冷库与探头 ---------- */

async function loadRoomsView() {
  const f = state.filters.rooms;
  const rp = new URLSearchParams();
  if (f.status) rp.set('status', f.status);
  if (f.type) rp.set('type', f.type);
  if (f.keyword) rp.set('keyword', f.keyword);
  const rooms = await api('GET', '/api/rooms' + (rp.toString() ? '?' + rp.toString() : ''));
  state.roomsView = rooms;
  renderRoomRows();
  renderProbeRows();
}

function visibleProbes() {
  const f = state.filters.rooms;
  return state.probes.filter(function (p) {
    if (f.probeStatus && p.status !== f.probeStatus) return false;
    if (f.probeCal === 'expired' && !p.expired) return false;
    if (f.probeCal === 'valid' && p.expired) return false;
    return true;
  });
}

function renderRoomRows() {
  const rows = state.roomsView || [];
  const tbody = $('roomRows');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">没有符合条件的冷库</td></tr>';
    return;
  }
  const html = rows.map(function (r) {
    const main = '<tr class="row-main" data-rowkind="room" data-id="' + esc(r.id) + '">' +
      '<td>' + esc(r.code) + '</td>' +
      '<td>' + esc(r.name) + '</td>' +
      '<td>' + esc(r.type) + '</td>' +
      '<td>' + esc(r.location) + '</td>' +
      '<td class="num">' + num(r.capacityPlt) + '</td>' +
      '<td>' + esc(r.status) + '</td>' +
      '<td class="num">' + num(r.probeCount) + '</td>' +
      '<td class="num">' + num(r.batchCount) + '</td>' +
      '<td class="num">' + num(r.openBatchCount) + '</td>' +
      '<td class="cell-actions">' +
      '<button type="button" class="btn btn-sm" data-action="room-edit" data-id="' + esc(r.id) + '">修改</button>' +
      '<button type="button" class="btn btn-sm btn-danger" data-action="room-del" data-id="' + esc(r.id) + '">删除</button>' +
      '</td></tr>';
    if (!state.expandedRooms.has(r.id)) return main;
    return main + roomDetailRow(r);
  }).join('');
  tbody.innerHTML = html;
}

function roomDetailRow(r) {
  const d = state.roomDetail[r.id];
  if (!d) return '<tr class="row-detail"><td colspan="10"><div class="detail-note">正在读取冷库详情…</div></td></tr>';
  const probes = (d.probes || []).map(function (p) {
    return '<tr' + (p.expired ? ' class="row-danger"' : '') + '><td>' + esc(p.code) + '</td><td>' + esc(p.position) + '</td>' +
      '<td>' + esc(p.status) + '</td><td>' + esc(p.calibratedUntil) + '</td>' +
      '<td class="num">' + num(p.recordCount) + '</td><td>' + (p.expired ? '已过期' : '有效') + '</td></tr>';
  }).join('') || '<tr><td colspan="6" class="empty">没有探头</td></tr>';
  const openBatches = (d.batches || []).filter(function (b) { return b.status === '在库' || b.status === '待放行'; });
  const batches = openBatches.map(function (b) {
    return '<tr><td>' + esc(b.code) + '</td><td>' + esc(b.product) + '</td><td class="num">' + num(b.units) + '</td>' +
      '<td>' + esc(b.status) + '</td><td class="num">' + num(b.recordCount) + '</td></tr>';
  }).join('') || '<tr><td colspan="5" class="empty">没有在办批次</td></tr>';
  return '<tr class="row-detail"><td colspan="10"><div class="detail-grid">' +
    '<div class="detail-block"><h4>探头清单（' + (d.probes || []).length + '）</h4>' +
    '<table class="mini-table"><thead><tr><th>编号</th><th>位置</th><th>状态</th><th>校准有效期</th><th class="num">记录数</th><th>是否过期</th></tr></thead><tbody>' + probes + '</tbody></table></div>' +
    '<div class="detail-block"><h4>在办批次（' + openBatches.length + '）</h4>' +
    '<table class="mini-table"><thead><tr><th>批次号</th><th>品名</th><th class="num">件数</th><th>状态</th><th class="num">记录数</th></tr></thead><tbody>' + batches + '</tbody></table></div>' +
    '</div></td></tr>';
}

function renderProbeRows() {
  const rows = visibleProbes();
  const tbody = $('probeRows');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">没有符合条件的探头</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(function (p) {
    return '<tr class="row-main' + (p.expired ? ' row-danger' : '') + '" data-rowkind="probe" data-id="' + esc(p.id) + '">' +
      '<td>' + esc(p.code) + '</td>' +
      '<td>' + esc(p.roomCode) + '</td>' +
      '<td>' + esc(p.position) + '</td>' +
      '<td>' + esc(p.status) + '</td>' +
      '<td>' + esc(p.calibratedUntil) + '</td>' +
      '<td class="num">' + num(p.recordCount) + '</td>' +
      '<td class="num">' + num(p.manualCount) + '</td>' +
      '<td>' + (p.expired ? pill('已过期', 'pill-bad') : pill('有效', 'pill-mute')) + '</td>' +
      '<td class="cell-actions">' +
      '<button type="button" class="btn btn-sm" data-action="probe-edit" data-id="' + esc(p.id) + '">修改</button>' +
      '<button type="button" class="btn btn-sm btn-danger" data-action="probe-del" data-id="' + esc(p.id) + '">删除</button>' +
      '</td></tr>';
  }).join('');
}

async function expandRoom(id) {
  if (!state.roomDetail[id]) {
    state.roomDetail[id] = await api('GET', '/api/rooms/' + encodeURIComponent(id));
  }
  state.expandedRooms.add(id);
  renderRoomRows();
}

/* ---------- 批次 ---------- */

async function loadBatchesView() {
  const f = state.filters.batches;
  const params = new URLSearchParams();
  if (f.status) params.set('status', f.status);
  if (f.roomId) params.set('roomId', f.roomId);
  if (f.product) params.set('product', f.product);
  let rows = await api('GET', '/api/batches' + (params.toString() ? '?' + params.toString() : ''));
  if (f.noRecord) rows = rows.filter(function (b) { return num(b.recordCount) === 0; });
  state.batchesView = rows;
  renderBatchRows();
}

function releaseSituation(b) {
  if (num(b.releaseCount) > 0 && b.lastDecision) {
    return b.lastDecision === '放行' ? pill('已放行', 'pill-ok') : pill('已拒收', 'pill-bad');
  }
  const pass = b.releaseCheck && b.releaseCheck.pass;
  return pass ? pill('满足放行条件', 'pill-ok') : pill('未满足放行条件', 'pill-bad');
}

function renderBatchRows() {
  const rows = state.batchesView || [];
  const tbody = $('batchRows');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="14" class="empty">没有符合条件的批次</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(function (b) {
    const main = '<tr class="row-main' + (num(b.unresolvedCount) ? ' row-danger' : (num(b.misTaggedCount) ? ' row-warn' : '')) + '" data-rowkind="batch" data-id="' + esc(b.id) + '">' +
      '<td>' + esc(b.code) + '</td>' +
      '<td>' + esc(b.product) + '</td>' +
      '<td>' + esc(b.spec) + '</td>' +
      '<td class="num">' + num(b.units) + '</td>' +
      '<td>' + esc(b.roomCode) + '</td>' +
      '<td>' + esc(b.loadedAt) + '</td>' +
      '<td>' + esc(b.status) + '</td>' +
      '<td class="num">' + num(b.recordCount) + '</td>' +
      '<td class="num">' + (num(b.unresolvedCount) ? '<strong class="text-bad">' + num(b.unresolvedCount) + '</strong>' : (num(b.misTaggedCount) ? '<span class="text-warn">' + num(b.misTaggedCount) + ' 错位</span>' : '0')) + '</td>' +
      '<td class="num">' + num(b.longestExcursionMinutes) + '</td>' +
      '<td class="num">' + num(b.totalExcursionMinutes) + '</td>' +
      '<td class="num">' + num(b.mkt) + '</td>' +
      '<td class="num">' + num(b.chainGapCount) + '</td>' +
      '<td>' + releaseSituation(b) + '</td>' +
      '</tr>';
    if (!state.expandedBatches.has(b.id)) return main;
    return main + batchDetailRow(b);
  }).join('');
}

function batchDetailRow(b) {
  const d = state.batchDetail[b.id];
  if (!d) return '<tr class="row-detail"><td colspan="14"><div class="detail-note">正在读取批次详情…</div></td></tr>';
  const out = state.batchOut[b.id] || {};

  const records = (d.records || []).map(function (r) {
    const oor = out[r.id];
    return '<tr' + (r.attributionStatus === '存疑' ? ' class="row-danger"' : r.attributionStatus === '账外归他' ? ' class="row-warn"' : '') + '><td>' + esc(r.at) + '</td><td>' + esc(r.probeCode) + '</td><td class="num">' + num(r.temperatureC) + '</td>' +
      '<td>' + esc(r.source) + '</td>' +
      '<td>' + (oor ? pill('超限', 'pill-bad') : pill('正常', 'pill-mute')) + '</td>' +
      '<td>' + (r.probeExpired ? pill('已过期', 'pill-bad') : pill('有效', 'pill-mute')) + '</td>' +
      '<td>' + attrPill(r.attributionStatus) + '</td></tr>';
  }).join('') || '<tr><td colspan="7" class="empty">没有温度记录</td></tr>';

  let segmentsHtml;
  if (d.segmentsUnavailable) {
    const emsg = (state.batchDetailError[b.id] && state.batchDetailError[b.id].message) || '批次详情接口报错';
    segmentsHtml = '<div class="detail-note">读不到超限段：' + esc(emsg) + '（服务端 /api/batches/:id 报错，已退回其他接口）</div>';
  } else {
    const segRows = (d.segments || []).map(function (s) {
      return '<tr><td>' + esc(s.startAt) + '</td><td>' + esc(s.endAt) + '</td><td class="num">' + num(s.minutes) + '</td>' +
        '<td class="num">' + num(s.peakC) + '</td><td class="num">' + num(s.points) + '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="empty">没有超限段</td></tr>';
    segmentsHtml = '<table class="mini-table"><thead><tr><th>起</th><th>止</th><th class="num">时长(分)</th><th class="num">峰值(℃)</th><th class="num">点数</th></tr></thead><tbody>' + segRows + '</tbody></table>';
  }

  const gaps = (d.chainGaps || []).map(function (g) {
    return '<tr><td>' + esc(g.from) + '</td><td>' + esc(g.to) + '</td><td class="num">' + num(g.minutes) + '</td>' +
      '<td class="num">' + num(g.countedMinutes) + '</td></tr>';
  }).join('') || '<tr><td colspan="4" class="empty">没有断链缺口</td></tr>';

  const check = d.releaseCheck || {};
  const conds = (check.conditions || []).slice();
  const expired = check.expiredProbes || [];
  conds.push({ key: 'calibration', ok: expired.length === 0, value: expired.length, limit: 0, text: '参与判定的探头都在校准有效期内' });
  const condHtml = conds.map(function (c) {
    let actual = c.value;
    if (c.key === 'attribution' && c.value && typeof c.value === 'object') {
      actual = '存疑 ' + num(c.value.unresolved) + ' 条，错位 ' + num(c.value.misTagged) + ' 条';
    }
    return '<li><span class="cond-text">' + okPill(c.ok) + ' ' + esc(c.text) + '</span>' +
      '<span class="cond-meta">实际 ' + esc(actual) + '，阈值 ' + esc(c.limit) + '</span></li>';
  }).join('');

  // 设备占用与归属块
  const attr = d.attribution || {};
  const occRows = (d.occupancies || []).map(function (o) {
    return '<tr' + (o.roomMismatch ? ' class="row-warn"' : '') + '><td>' + esc(o.roomCode) + '</td><td>' + (o.probeCode ? esc(o.probeCode) : '仅设备') + '</td>' +
      '<td>' + esc(o.startAt) + '</td><td>' + (o.open ? '占用中' : esc(o.endAt)) + '</td><td>' + (o.source === 'manual' ? '手工' : '自动') + '</td></tr>';
  }).join('') || '<tr><td colspan="5" class="empty">没有占用账行</td></tr>';

  const unresolvedRows = (attr.unresolved || []).map(function (r) {
    let action;
    if (r.reason === 'same-instant-conflict') {
      action = '<span class="sub-line">同一时刻有两条读数，删掉录错的那条即可</span>' +
        '<button type="button" class="btn btn-sm btn-danger" data-action="record-del" data-id="' + esc(r.id) + '">删除这条</button>';
    } else {
      action = '<button type="button" class="btn btn-sm" data-action="occ-add-for" data-id="' + esc(r.id) + '" data-probe="' + esc(r.probeId) + '" data-batch="' + esc(b.id) + '" data-at="' + esc(r.at) + '">补占用账</button>';
    }
    return '<tr><td>' + esc(r.at) + '</td><td>' + esc(r.probeCode) + '</td><td class="num">' + num(r.temperatureC) + '</td><td>' + esc(attrReasonText(r.reason)) + '</td><td>' + action + '</td></tr>';
  }).join('') || '<tr><td colspan="5" class="empty">没有存疑记录</td></tr>';

  const claimedInRows = (attr.claimedIn || []).map(function (r) {
    return '<tr><td>' + esc(r.at) + '</td><td>' + esc(r.probeCode) + '</td><td class="num">' + num(r.temperatureC) + '</td><td>' + esc(r.taggedBatchCode) + '</td></tr>';
  }).join('') || '<tr><td colspan="4" class="empty">没有从别的批次裁入的记录</td></tr>';

  const misTaggedRows = (attr.misTagged || []).map(function (r) {
    return '<tr><td>' + esc(r.at) + '</td><td>' + esc(r.probeCode) + '</td><td class="num">' + num(r.temperatureC) + '</td><td>' + esc(attrReasonText(r.reason)) + '</td><td>' + esc(r.resolvedBatchCode) + '</td>' +
      '<td><button type="button" class="btn btn-sm" data-action="record-retag" data-id="' + esc(r.id) + '" data-to="' + esc(r.resolvedBatchId) + '">改挂到 ' + esc(r.resolvedBatchCode) + '</button></td></tr>';
  }).join('') || '<tr><td colspan="6" class="empty">没有错位记录</td></tr>';

  const overlapRowsHtml = (attr.overlaps || []).map(function (w) {
    const order = (w.order || []).map(function (x) { return esc(x.batchCode); }).join(' → ');
    const slices = (w.slices || []).map(function (s) {
      return esc(s.batchCode) + ' ' + esc(s.startAt) + '→' + esc(s.endAt);
    }).join('；') || '—';
    return '<tr><td>' + esc(w.probeCode) + '</td><td>' + esc(w.startAt) + '<br><span class="sub-line">→ ' + esc(w.endAt) + '</span></td><td>' + order + '</td><td>' + slices + '</td></tr>';
  }).join('') || '<tr><td colspan="4" class="empty">没有与别的批次重叠的时段</td></tr>';

  const attributionBlock =
    '<div class="detail-block detail-block-wide"><h4>设备占用与归属</h4>' +
    '<div class="attr-summary">挂在本批 ' + num(attr.taggedCount) + ' 条；从别批裁入 ' + num(attr.claimedInCount) + ' 条；错位 ' + num(attr.misTaggedCount) + ' 条；存疑 ' + num(attr.unresolvedCount) + ' 条（存疑或错位存在时不能放行）</div>' +
    '<table class="mini-table"><thead><tr><th>设备</th><th>探头</th><th>开始</th><th>结束</th><th>来源</th></tr></thead><tbody>' + occRows + '</tbody></table>' +
    '<h4>重叠窗（' + (attr.overlaps || []).length + '）</h4>' +
    '<table class="mini-table"><thead><tr><th>探头</th><th>重叠时段</th><th>先后顺序</th><th>切开后各得</th></tr></thead><tbody>' + overlapRowsHtml + '</tbody></table>' +
    '<h4>存疑记录（' + (attr.unresolved || []).length + '）——不计入任何批次；补一条覆盖该时段的探头占用即可消疑</h4>' +
    '<table class="mini-table"><thead><tr><th>时刻</th><th>探头</th><th class="num">温度</th><th>原因</th><th>操作</th></tr></thead><tbody>' + unresolvedRows + '</tbody></table>' +
    '<h4>错位记录（' + (attr.misTagged || []).length + '）——挂着本批但按占用账属于别的批次，可一键改挂</h4>' +
    '<table class="mini-table"><thead><tr><th>时刻</th><th>探头</th><th class="num">温度</th><th>原因</th><th>应归</th><th>操作</th></tr></thead><tbody>' + misTaggedRows + '</tbody></table>' +
    '<h4>从别批裁入本批的记录（' + (attr.claimedIn || []).length + '）</h4>' +
    '<table class="mini-table"><thead><tr><th>时刻</th><th>探头</th><th class="num">温度</th><th>原挂批次</th></tr></thead><tbody>' + claimedInRows + '</tbody></table></div>';

  const expiredProbes = expired.map(function (p) {
    return '<tr><td>' + esc(p.probeCode) + '</td><td>' + esc(p.calibratedUntil) + '</td><td>' + esc(p.at) + '</td></tr>';
  }).join('') || '<tr><td colspan="3" class="empty">没有已过校准期的探头</td></tr>';

  const releases = (d.releases || []).map(function (r) {
    return '<tr><td>' + esc(r.decision) + '</td><td>' + esc(r.decidedAt) + '</td><td>' + esc(r.decider) + '</td>' +
      '<td class="num">' + num(r.mkt) + '</td><td>' + esc(r.basis) + '</td></tr>';
  }).join('') || '<tr><td colspan="5" class="empty">没有放行记录</td></tr>';

  const decisionBtns = '<div class="detail-actions">' +
    '<button type="button" class="btn btn-primary" data-action="batch-release" data-id="' + esc(b.id) + '">放行</button>' +
    '<button type="button" class="btn" data-action="batch-reject" data-id="' + esc(b.id) + '">拒收</button>' +
    '<button type="button" class="btn" data-action="batch-edit" data-id="' + esc(b.id) + '">修改批次</button>' +
    '<button type="button" class="btn btn-danger" data-action="batch-del" data-id="' + esc(b.id) + '">删除</button>' +
    '</div>';

  return '<tr class="row-detail"><td colspan="14">' +
    '<div class="detail-grid">' +
    '<div class="detail-block"><h4>温度记录（' + (d.records || []).length + '）</h4>' +
    '<table class="mini-table"><thead><tr><th>时刻</th><th>探头</th><th class="num">温度(℃)</th><th>来源</th><th>是否超限</th><th>探头是否过期</th><th>归属</th></tr></thead><tbody>' + records + '</tbody></table></div>' +
    '<div class="detail-block"><h4>超限段（' + (d.segments || []).length + '）</h4>' + segmentsHtml +
    '<h4>断链缺口（' + (d.chainGaps || []).length + '）</h4>' +
    '<table class="mini-table"><thead><tr><th>起</th><th>止</th><th class="num">实际(分)</th><th class="num">计入(分)</th></tr></thead><tbody>' + gaps + '</tbody></table></div>' +
    '<div class="detail-block"><h4>放行判定</h4><ul class="cond-list">' + condHtml + '</ul>' +
    '<h4>已过校准期的探头（' + expired.length + '）</h4>' +
    '<table class="mini-table"><thead><tr><th>探头</th><th>校准有效期</th><th>记录时刻</th></tr></thead><tbody>' + expiredProbes + '</tbody></table></div>' +
    '<div class="detail-block"><h4>放行记录（' + (d.releases || []).length + '）</h4>' +
    '<table class="mini-table"><thead><tr><th>决定</th><th>时刻</th><th>经办人</th><th class="num">MKT</th><th>依据</th></tr></thead><tbody>' + releases + '</tbody></table>' +
    decisionBtns + '</div>' +
    attributionBlock +
    '</div></td></tr>';
}

async function expandBatch(id) {
  if (!state.batchDetail[id]) {
    let detail = null;
    let detailError = null;
    let records = [];
    try {
      const results = await Promise.all([
        api('GET', '/api/batches/' + encodeURIComponent(id)),
        api('GET', '/api/records?batchId=' + encodeURIComponent(id))
      ]);
      detail = results[0];
      records = results[1] || [];
    } catch (err) {
      /* 服务端 /api/batches/:id 在有记录时会 500（coldlib.probeOf 未导出），
         这里退回可用的接口拼出详情，保证页面不空着、并如实显示报错。 */
      detailError = err;
      const fallback = await Promise.all([
        api('GET', '/api/batches/' + encodeURIComponent(id) + '/release-check'),
        api('GET', '/api/records?batchId=' + encodeURIComponent(id)),
        api('GET', '/api/releases?batchId=' + encodeURIComponent(id)),
        api('GET', '/api/batches/' + encodeURIComponent(id) + '/attribution')
      ]);
      const check = fallback[0];
      records = fallback[1] || [];
      const attr = fallback[3] || { unresolved: [], misTagged: [], claimedIn: [], overlaps: [] };
      const base = findBatch(id) || {};
      detail = Object.assign({}, base, {
        records: records.map(function (r) {
          const probe = state.probes.find(function (p) { return p.id === r.probeId; });
          return Object.assign({}, r, { probeCode: r.probeCode, probeExpired: probe ? !!probe.expired : false });
        }),
        effectiveRecords: [],
        segments: [],
        segmentsUnavailable: true,
        chainGaps: (check.chain && check.chain.gaps) || [],
        occupancies: attr.occupancies || [],
        attribution: attr,
        releases: fallback[2] || [],
        releaseCheck: check,
        __fallback: true
      });
    }
    const map = {};
    records.forEach(function (r) { map[r.id] = r.outOfRange; });
    state.batchDetail[id] = detail;
    state.batchOut[id] = map;
    state.batchDetailError[id] = detailError;
  }
  state.expandedBatches.add(id);
  renderBatchRows();
}

/* ---------- 设备占用账 ---------- */

async function loadLedgerView() {
  const f = state.filters.ledger;
  const params = new URLSearchParams();
  if (f.roomId) params.set('roomId', f.roomId);
  if (f.probeId) params.set('probeId', f.probeId);
  if (f.batchId) params.set('batchId', f.batchId);
  const qs = params.toString() ? '?' + params.toString() : '';
  const results = await Promise.all([
    api('GET', '/api/occupancies/timeline' + qs),
    api('GET', '/api/occupancies' + qs)
  ]);
  state.ledger = { devices: results[0].devices || [], policy: results[0].policy, occupancies: results[1] || [] };
  renderPolicyCard();
  renderTimelines();
  renderLedgerRows();
  renderOverlapRows();
}

function renderPolicyCard() {
  const p = state.ledger.policy || {};
  const html =
    '<div class="policy-head"><strong>当前重叠裁决口径</strong>' +
    '<button type="button" class="btn btn-sm" data-action="open-settings">去设置里改</button></div>' +
    '<ul class="policy-list">' +
    '<li><span class="policy-k">重叠怎么切</span><span>' + esc(policyLabel(OVERLAP_POLICY_OPTIONS, p.overlapPolicy)) + '</span></li>' +
    '<li><span class="policy-k">边界时刻算谁的</span><span>' + esc(policyLabel(BOUNDARY_OPTIONS, p.boundaryPolicy)) + '</span></li>' +
    '<li><span class="policy-k">裁决依据（谁先谁后）</span><span>' + esc(policyLabel(TIE_BASIS_OPTIONS, p.overlapTieBasis)) + '</span></li>' +
    '</ul>' +
    '<div class="policy-note">记录归属落到「批次 + 设备 + 探头 + 时段」。重叠窗按上面的口径切开后分别计入各批次；切不开或没有占用账的时段显式标「存疑」，不计入任何批次，并作为放行判定的一条。换库位/换车厢时在批次上登记交接时刻，旧时段的占用原样留账。</div>';
  $('policyCard').innerHTML = html;
}

function timeToMs(s) { return new Date(String(s).replace(' ', 'T') + '+08:00').getTime(); }

function batchColor(batchId) {
  let h = 0;
  for (let i = 0; i < String(batchId).length; i += 1) h = (h * 31 + batchId.charCodeAt(i)) >>> 0;
  return TIMELINE_COLORS[h % TIMELINE_COLORS.length];
}

function findBatchCode(id) {
  const b = state.batches.find(function (x) { return x.id === id; });
  return b ? b.code : id;
}

function renderTimelines() {
  const host = $('ledgerTimelines');
  const devices = state.ledger.devices || [];
  if (!devices.length) {
    host.innerHTML = '<div class="empty">没有探头占用账（可在下方手工登记，或在批次里补温度记录后自动回填）</div>';
    return;
  }
  // 全局时间范围取所有设备占用段的并集，保证不同探头的同一时刻在视觉上对齐
  const rowEndMs = function (o) {
    if (o.endAt) return timeToMs(o.endAt);
    return timeToMs(o.startAt) + Math.max(num(o.durationMinutes), 15) * 60000;
  };
  let minMs = Infinity;
  let maxMs = -Infinity;
  devices.forEach(function (dev) {
    dev.rows.forEach(function (o) {
      minMs = Math.min(minMs, timeToMs(o.startAt));
      maxMs = Math.max(maxMs, rowEndMs(o));
    });
  });
  if (maxMs <= minMs) maxMs = minMs + 3600000;
  const span = maxMs - minMs;

  host.innerHTML = devices.map(function (dev) {
    const bars = dev.rows.map(function (o) {
      const endMs = rowEndMs(o);
      const left = ((timeToMs(o.startAt) - minMs) / span * 100).toFixed(2);
      const width = Math.max(0.6, ((endMs - timeToMs(o.startAt)) / span * 100)).toFixed(2);
      const color = batchColor(o.batchId);
      return '<div class="tl-seg' + (o.open ? ' is-open' : '') + '" style="left:' + left + '%;width:' + width + '%;background:' + color + '" ' +
        'title="' + esc(o.batchCode) + '｜' + esc(o.startAt) + ' → ' + esc(o.endAt || '占用中') + '｜' + num(o.durationMinutes) + ' 分钟">' +
        '<span class="tl-seg-label">' + esc(o.batchCode) + '</span></div>';
    }).join('');
    const winBars = dev.windows.map(function (w) {
      const left = ((timeToMs(w.startAt) - minMs) / span * 100).toFixed(2);
      const width = Math.max(0.6, ((timeToMs(w.endAt) - timeToMs(w.startAt)) / span * 100)).toFixed(2);
      const orderText = w.members.map(function (m) {
        return findBatchCode(m.batchId) + '：' + (m.sliceStartAt || '—') + ' → ' + (m.sliceEndAt || '—') + '（记录 ' + num(m.recordCount) + ' 条）';
      }).join('&#10;');
      return '<div class="tl-overlap" style="left:' + left + '%;width:' + width + '%" title="' +
        esc('重叠 ' + w.startAt + ' → ' + w.endAt + '｜存疑 ' + w.unresolvedCount + ' 条') + '&#10;' + orderText + '"></div>';
    }).join('');
    return '<div class="tl-row">' +
      '<div class="tl-label"><span class="tl-probe">' + esc(dev.probeCode) + '</span><span class="tl-room">' + esc(dev.roomCode) + '</span></div>' +
      '<div class="tl-track">' + bars + winBars + '</div></div>';
  }).join('');
}

function renderLedgerRows() {
  const tbody = $('ledgerRows');
  const rows = state.ledger.occupancies || [];
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">没有符合条件的占用账行</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(function (o) {
    const overlap = overlapInfoFor(o);
    return '<tr class="row-main' + (o.roomMismatch ? ' row-warn' : '') + '" data-rowkind="occupancy" data-id="' + esc(o.id) + '">' +
      '<td>' + esc(o.batchCode) + '</td>' +
      '<td>' + esc(o.roomCode) + (o.roomMismatch ? ' ' + pill('探头已挪位置', 'pill-warn') : '') + '</td>' +
      '<td>' + (o.probeCode ? esc(o.probeCode) : pill('仅设备', 'pill-mute')) + '</td>' +
      '<td>' + esc(o.startAt) + '</td>' +
      '<td>' + (o.open ? pill('占用中', 'pill-info') : esc(o.endAt)) + '</td>' +
      '<td class="num">' + num(o.durationMinutes) + '</td>' +
      '<td>' + (o.source === 'manual' ? '手工' : '自动') + '</td>' +
      '<td>' + (overlap ? pill('重叠 ' + num(overlap.unresolvedCount) + ' 存疑', overlap.unresolvedCount ? 'pill-bad' : 'pill-warn') : pill('独立', 'pill-mute')) + '</td>' +
      '<td>' + esc(o.remark) + '</td>' +
      '<td class="cell-actions">' +
      '<button type="button" class="btn btn-sm" data-action="occ-edit" data-id="' + esc(o.id) + '">修改</button>' +
      '<button type="button" class="btn btn-sm" data-action="occ-split" data-id="' + esc(o.id) + '">拆分</button>' +
      '<button type="button" class="btn btn-sm btn-danger" data-action="occ-del" data-id="' + esc(o.id) + '">删除</button>' +
      '</td></tr>';
  }).join('');
}

function findOccupancy(id) {
  return (state.ledger.occupancies || []).find(function (o) { return o.id === id; }) || null;
}

function overlapInfoFor(o) {
  if (!o.probeId) return null;
  const dev = (state.ledger.devices || []).find(function (d) { return d.probeId === o.probeId; });
  if (!dev) return null;
  const hit = dev.windows.find(function (w) { return w.startAt >= o.startAt && (!o.endAt || w.endAt <= o.endAt); });
  return hit || null;
}

function renderOverlapRows() {
  const tbody = $('overlapRows');
  const wins = [];
  (state.ledger.devices || []).forEach(function (dev) {
    dev.windows.forEach(function (w) { wins.push({ dev: dev, w: w }); });
  });
  if (!wins.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">当前筛选下没有重叠占用窗</td></tr>';
    return;
  }
  tbody.innerHTML = wins.map(function (item) {
    const w = item.w;
    const order = w.members.map(function (m, i) {
      return (i + 1) + '. ' + esc(findBatchCode(m.batchId));
    }).join('　');
    const slices = w.policy === 'midpoint'
      ? w.members.map(function (m) {
        return esc(findBatchCode(m.batchId)) + ' ' + esc(m.sliceStartAt) + '→' + esc(m.sliceEndAt) + '（' + num(m.recordCount) + '条）';
      }).join('<br>')
      : (w.policy === 'firstWins'
        ? esc(findBatchCode(w.members[0].batchId)) + ' 全得（' + num(w.members[0].recordCount) + ' 条）'
        : '整段挂起，' + num(w.unresolvedCount) + ' 条全部存疑');
    const policyText = policyLabel(OVERLAP_POLICY_OPTIONS, w.policy).split('：')[0] + ' / ' +
      policyLabel(BOUNDARY_OPTIONS, w.boundary).split('：')[0] + ' / ' + policyLabel(TIE_BASIS_OPTIONS, w.basis).split('（')[0];
    return '<tr' + (w.unresolvedCount ? ' class="row-danger"' : '') + '>' +
      '<td>' + esc(item.dev.probeCode) + '</td>' +
      '<td>' + esc(w.startAt) + '<br><span class="sub-line">→ ' + esc(w.endAt) + '</span></td>' +
      '<td>' + order + '</td>' +
      '<td>' + slices + '</td>' +
      '<td class="num">' + num(w.awardedCount) + '</td>' +
      '<td class="num">' + (w.unresolvedCount ? '<strong>' + num(w.unresolvedCount) + '</strong>' : '0') + '</td>' +
      '<td>' + esc(policyText) + '</td>' +
      '</tr>';
  }).join('');
}

/* ---------- 温度记录 ---------- */

async function loadRecordsView() {
  const f = state.filters.records;
  const params = new URLSearchParams();
  if (f.batchId) params.set('batchId', f.batchId);
  if (f.probeId) params.set('probeId', f.probeId);
  if (f.source) params.set('source', f.source);
  if (f.attribution) params.set('attribution', f.attribution);
  if (f.from) params.set('from', toApiTime(f.from));
  if (f.to) params.set('to', toApiTime(f.to));
  const rows = await api('GET', '/api/records' + (params.toString() ? '?' + params.toString() : ''));
  state.recordsView = rows;
  const batchSelected = !!f.batchId;
  const shown = batchSelected ? rows : rows.slice(0, RECORD_PAGE);
  $('recordsNote').textContent = batchSelected
    ? ('共 ' + rows.length + ' 条，已全部显示')
    : ('共 ' + rows.length + ' 条，已显示前 ' + Math.min(RECORD_PAGE, rows.length) + ' 条');
  const tbody = $('recordRows');
  if (!shown.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">没有符合条件的温度记录</td></tr>';
    return;
  }
  tbody.innerHTML = shown.map(function (r) {
    const other = r.attributionStatus === '账外归他' && r.resolvedBatchCode && r.resolvedBatchCode !== r.batchCode;
    const attrCell = attrPill(r.attributionStatus) +
      (other ? '<div class="sub-line">应归 ' + esc(r.resolvedBatchCode) + '</div>' : '') +
      (r.attributionStatus === '存疑' ? '<div class="sub-line">' + esc(attrReasonText(r.attributionReason)) + '</div>' : '');
    return '<tr class="row-main' + (r.attributionStatus === '存疑' ? ' row-danger' : r.attributionStatus === '账外归他' ? ' row-warn' : '') + '" data-rowkind="record" data-id="' + esc(r.id) + '">' +
      '<td>' + esc(r.batchCode) + '</td>' +
      '<td>' + esc(r.probeCode) + '</td>' +
      '<td>' + esc(r.at) + '</td>' +
      '<td class="num">' + num(r.temperatureC) + '</td>' +
      '<td>' + esc(r.source) + '</td>' +
      '<td>' + esc(r.operator) + '</td>' +
      '<td>' + (r.outOfRange ? pill('超限', 'pill-bad') : pill('正常', 'pill-mute')) + '</td>' +
      '<td>' + attrCell + '</td>' +
      '<td class="cell-actions"><button type="button" class="btn btn-sm btn-danger" data-action="record-del" data-id="' + esc(r.id) + '">删除</button></td>' +
      '</tr>';
  }).join('');
}

function toApiTime(v) {
  if (!v) return '';
  return String(v).replace('T', ' ') + ':00';
}

/* ---------- 放行台账 ---------- */

async function loadReleasesView() {
  const f = state.filters.releases;
  const params = new URLSearchParams();
  if (f.decision) params.set('decision', f.decision);
  const rows = await api('GET', '/api/releases' + (params.toString() ? '?' + params.toString() : ''));
  state.releasesView = rows;
  const s = state.summary;
  if (s) {
    $('releasesNote').textContent = '放行 ' + num(s.releasedCount) + ' 条，拒收 ' + num(s.rejectedCount) + ' 条';
  } else {
    const rel = rows.filter(function (r) { return r.decision === '放行'; }).length;
    const rej = rows.filter(function (r) { return r.decision === '拒收'; }).length;
    $('releasesNote').textContent = '放行 ' + rel + ' 条，拒收 ' + rej + ' 条';
  }
  const tbody = $('releaseRows');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">没有符合条件的放行记录</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(function (r) {
    return '<tr class="row-main" data-rowkind="release" data-id="' + esc(r.id) + '">' +
      '<td>' + esc(r.batchCode) + '</td>' +
      '<td>' + (r.decision === '放行' ? pill('放行', 'pill-ok') : pill('拒收', 'pill-bad')) + '</td>' +
      '<td>' + esc(r.decidedAt) + '</td>' +
      '<td>' + esc(r.decider) + '</td>' +
      '<td class="num">' + num(r.mkt) + '</td>' +
      '<td class="num">' + num(r.longestExcursionMinutes) + '</td>' +
      '<td class="num">' + num(r.totalExcursionMinutes) + '</td>' +
      '<td class="num">' + num(r.chainGapCount) + '</td>' +
      '<td>' + esc(r.basis) + '</td>' +
      '<td>' + esc(r.remark) + '</td>' +
      '</tr>';
  }).join('');
}

/* ---------- 左侧筛选栏 ---------- */

function selectHtml(name, options, value) {
  const opts = options.map(function (o) {
    return '<option value="' + esc(o.value) + '"' + (String(o.value) === String(value) ? ' selected' : '') + '>' + esc(o.label) + '</option>';
  }).join('');
  return '<select data-filter="' + name + '">' + opts + '</select>';
}

function textHtml(name, value, placeholder) {
  return '<input type="text" data-filter="' + name + '" value="' + esc(value) + '" placeholder="' + esc(placeholder || '') + '">';
}

function renderFilters() {
  const host = $('filters');
  const v = state.view;
  let html = '';
  if (v === 'overview') {
    html = '<h3>概览</h3><div class="filter-hint">点指标卡跳到对应标签并带上筛选；点冷库行跳到冷库标签并展开。</div>';
  } else if (v === 'rooms') {
    const f = state.filters.rooms;
    html = '<h3>冷库筛选</h3>' +
      '<div class="filter-field"><label>状态</label>' + selectHtml('status', [{ value: '', label: '全部' }].concat(ROOM_STATUS.map(function (s) { return { value: s, label: s }; })), f.status) + '</div>' +
      '<div class="filter-field"><label>类型</label>' + selectHtml('type', [{ value: '', label: '全部' }].concat(ROOM_TYPE.map(function (s) { return { value: s, label: s }; })), f.type) + '</div>' +
      '<div class="filter-field"><label>关键字</label>' + textHtml('keyword', f.keyword, '编码/名称/位置') + '</div>' +
      '<h3>探头筛选</h3>' +
      '<div class="filter-field"><label>状态</label>' + selectHtml('probeStatus', [{ value: '', label: '全部' }].concat(PROBE_STATUS.map(function (s) { return { value: s, label: s }; })), f.probeStatus) + '</div>' +
      '<div class="filter-field"><label>校准</label>' + selectHtml('probeCal', [{ value: 'all', label: '全部' }, { value: 'expired', label: '已过期' }, { value: 'valid', label: '有效' }], f.probeCal) + '</div>';
  } else if (v === 'batches') {
    const f = state.filters.batches;
    const roomSel = [{ value: '', label: '全部' }].concat(state.rooms.map(function (r) { return { value: r.id, label: r.code + ' ' + r.name }; }));
    html = '<h3>批次筛选</h3>' +
      '<div class="filter-field"><label>状态</label>' + selectHtml('status', [{ value: '', label: '全部' }].concat(BATCH_STATUS.map(function (s) { return { value: s, label: s }; })), f.status) + '</div>' +
      '<div class="filter-field"><label>所在冷库</label>' + selectHtml('roomId', roomSel, f.roomId) + '</div>' +
      '<div class="filter-field"><label>品名</label>' + textHtml('product', f.product, '品名关键字') + '</div>' +
      '<div class="filter-field"><label>只看无记录</label><input type="checkbox" data-filter="noRecord"' + (f.noRecord ? ' checked' : '') + '></div>';
  } else if (v === 'ledger') {
    const f = state.filters.ledger;
    const roomSel = [{ value: '', label: '全部设备' }].concat(state.rooms.map(function (r) { return { value: r.id, label: r.code + ' ' + r.name }; }));
    const probeSel = [{ value: '', label: '全部探头' }].concat(state.probes.map(function (p) { return { value: p.id, label: p.code }; }));
    const batchSel = [{ value: '', label: '全部批次' }].concat(state.batches.map(function (b) { return { value: b.id, label: b.code }; }));
    html = '<h3>占用账筛选</h3>' +
      '<div class="filter-field"><label>设备</label>' + selectHtml('roomId', roomSel, f.roomId) + '</div>' +
      '<div class="filter-field"><label>探头</label>' + selectHtml('probeId', probeSel, f.probeId) + '</div>' +
      '<div class="filter-field"><label>批次</label>' + selectHtml('batchId', batchSel, f.batchId) + '</div>' +
      '<div class="filter-hint">占用账记录批次在什么时段占着哪个设备/探头；同一探头同一时段多批占用会标出重叠窗。</div>';
  } else if (v === 'records') {
    const f = state.filters.records;
    const batchSel = [{ value: '', label: '全部' }].concat(state.batches.map(function (b) { return { value: b.id, label: b.code }; }));
    const probeSel = [{ value: '', label: '全部' }].concat(state.probes.map(function (p) { return { value: p.id, label: p.code }; }));
    html = '<h3>记录筛选</h3>' +
      '<div class="filter-field"><label>批次</label>' + selectHtml('batchId', batchSel, f.batchId) + '</div>' +
      '<div class="filter-field"><label>探头</label>' + selectHtml('probeId', probeSel, f.probeId) + '</div>' +
      '<div class="filter-field"><label>来源</label>' + selectHtml('source', [{ value: '', label: '全部' }].concat(SOURCE_LIST.map(function (s) { return { value: s, label: s }; })), f.source) + '</div>' +
      '<div class="filter-field"><label>归属</label>' + selectHtml('attribution', [{ value: '', label: '全部' }].concat(ATTR_STATUS.map(function (s) { return { value: s, label: s }; })), f.attribution) + '</div>' +
      '<div class="filter-field"><label>起</label><input type="datetime-local" data-filter="from" value="' + esc(f.from) + '"></div>' +
      '<div class="filter-field"><label>止</label><input type="datetime-local" data-filter="to" value="' + esc(f.to) + '"></div>' +
      '<div class="filter-hint">不选批次时只渲染前 ' + RECORD_PAGE + ' 条；选定批次后显示该批次全部记录。</div>';
  } else if (v === 'releases') {
    const f = state.filters.releases;
    html = '<h3>台账筛选</h3>' +
      '<div class="filter-field"><label>决定</label>' + selectHtml('decision', [{ value: '', label: '全部' }, { value: '放行', label: '放行' }, { value: '拒收', label: '拒收' }], f.decision) + '</div>';
  }
  host.innerHTML = html;
}

let filterTimer = null;
function onFilterInput(e) {
  const key = e.target.dataset.filter;
  if (!key) return;
  const f = state.filters[state.view];
  if (!f) return;
  if (e.target.type === 'checkbox') f[key] = e.target.checked;
  else f[key] = e.target.value;
  if (filterTimer) clearTimeout(filterTimer);
  filterTimer = setTimeout(function () { loadView(state.view); }, 250);
}

/* ---------- 表单弹层 ---------- */

function optionList(list, selected) {
  return list.map(function (o) {
    return '<option value="' + esc(o.value) + '"' + (o.value === selected ? ' selected' : '') + '>' + esc(o.label) + '</option>';
  }).join('');
}

function openSettings() {
  const s = state.settings || {};
  const body =
    '<div class="field"><label>温度带下限（℃）</label><input type="number" step="0.1" data-field="lowerLimitC" value="' + esc(s.lowerLimitC) + '"></div>' +
    '<div class="field"><label>温度带上限（℃）</label><input type="number" step="0.1" data-field="upperLimitC" value="' + esc(s.upperLimitC) + '"></div>' +
    '<div class="field"><label>单次允许超限（分钟）</label><input type="number" step="1" data-field="allowExcursionMinutes" value="' + esc(s.allowExcursionMinutes) + '"></div>' +
    '<div class="field"><label>累计允许超限（分钟）</label><input type="number" step="1" data-field="allowTotalExcursionMinutes" value="' + esc(s.allowTotalExcursionMinutes) + '"></div>' +
    '<div class="field"><label>断链门槛（分钟）</label><input type="number" step="1" data-field="chainGapMinutes" value="' + esc(s.chainGapMinutes) + '"></div>' +
    '<div class="field"><label>记录间隔（分钟）</label><input type="number" step="1" data-field="recordIntervalMinutes" value="' + esc(s.recordIntervalMinutes) + '"></div>' +
    '<div class="field settings-divider"><label>重叠时段怎么切</label><select data-field="overlapPolicy">' + optionList(OVERLAP_POLICY_OPTIONS, s.overlapPolicy) + '</select></div>' +
    '<div class="field"><label>边界时刻算谁的</label><select data-field="boundaryPolicy">' + optionList(BOUNDARY_OPTIONS, s.boundaryPolicy) + '</select></div>' +
    '<div class="field"><label>重叠时的裁决依据（谁先谁后）</label><select data-field="overlapTieBasis">' + optionList(TIE_BASIS_OPTIONS, s.overlapTieBasis) + '</select></div>';
  openModal('设置', body, '保存', async function () {
    const v = formValues();
    const payload = {
      lowerLimitC: Number(v.lowerLimitC),
      upperLimitC: Number(v.upperLimitC),
      allowExcursionMinutes: Number(v.allowExcursionMinutes),
      allowTotalExcursionMinutes: Number(v.allowTotalExcursionMinutes),
      chainGapMinutes: Number(v.chainGapMinutes),
      recordIntervalMinutes: Number(v.recordIntervalMinutes),
      overlapPolicy: v.overlapPolicy,
      boundaryPolicy: v.boundaryPolicy,
      overlapTieBasis: v.overlapTieBasis
    };
    try {
      state.settings = await api('PATCH', '/api/settings', payload);
      closeModal();
      await refreshAfterMutation();
    } catch (err) { showError(err); }
  });
}

function openRoomForm(room) {
  const isEdit = !!room;
  const r = room || { code: '', name: '', type: '冷藏库', location: '', capacityPlt: 0, status: '运行', remark: '' };
  const body =
    '<div class="field"><label>编码</label><input type="text" data-field="code" value="' + esc(r.code) + '"' + (isEdit ? ' disabled' : '') + '></div>' +
    '<div class="field"><label>名称</label><input type="text" data-field="name" value="' + esc(r.name) + '"></div>' +
    '<div class="field"><label>类型</label><select data-field="type">' + ROOM_TYPE.map(function (t) { return '<option value="' + esc(t) + '"' + (t === r.type ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join('') + '</select></div>' +
    '<div class="field"><label>位置</label><input type="text" data-field="location" value="' + esc(r.location) + '"></div>' +
    '<div class="field"><label>库位</label><input type="number" step="1" data-field="capacityPlt" value="' + esc(r.capacityPlt) + '"></div>' +
    '<div class="field"><label>状态</label><select data-field="status">' + ROOM_STATUS.map(function (t) { return '<option value="' + esc(t) + '"' + (t === r.status ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join('') + '</select></div>' +
    '<div class="field"><label>备注</label><textarea data-field="remark">' + esc(r.remark) + '</textarea></div>';
  openModal(isEdit ? '修改冷库' : '新增冷库', body, isEdit ? '保存' : '新增', async function () {
    const v = formValues();
    const payload = {
      code: v.code, name: v.name, type: v.type, location: v.location,
      capacityPlt: Number(v.capacityPlt), status: v.status, remark: v.remark
    };
    try {
      if (isEdit) await api('PATCH', '/api/rooms/' + encodeURIComponent(room.id), payload);
      else await api('POST', '/api/rooms', payload);
      closeModal();
      await refreshAfterMutation();
    } catch (err) { showError(err); }
  });
}

function openProbeForm(probe) {
  const isEdit = !!probe;
  const p = probe || { code: '', roomId: state.rooms.length ? state.rooms[0].id : '', position: '', status: '在用', calibratedUntil: '', remark: '' };
  const body =
    '<div class="field"><label>编号</label><input type="text" data-field="code" value="' + esc(p.code) + '"' + (isEdit ? ' disabled' : '') + '></div>' +
    '<div class="field"><label>所属冷库</label><select data-field="roomId">' + roomOptions(p.roomId) + '</select></div>' +
    '<div class="field"><label>位置</label><input type="text" data-field="position" value="' + esc(p.position) + '"></div>' +
    '<div class="field"><label>状态</label><select data-field="status">' + PROBE_STATUS.map(function (t) { return '<option value="' + esc(t) + '"' + (t === p.status ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join('') + '</select></div>' +
    '<div class="field"><label>校准有效期</label><input type="text" data-field="calibratedUntil" value="' + esc(p.calibratedUntil) + '" placeholder="2026-12-31"><div class="field-hint">格式：2026-12-31</div></div>' +
    '<div class="field"><label>备注</label><textarea data-field="remark">' + esc(p.remark) + '</textarea></div>';
  openModal(isEdit ? '修改探头' : '新增探头', body, isEdit ? '保存' : '新增', async function () {
    const v = formValues();
    const payload = {
      code: v.code, roomId: v.roomId, position: v.position,
      status: v.status, calibratedUntil: v.calibratedUntil, remark: v.remark
    };
    try {
      if (isEdit) await api('PATCH', '/api/probes/' + encodeURIComponent(probe.id), payload);
      else await api('POST', '/api/probes', payload);
      closeModal();
      await refreshAfterMutation();
    } catch (err) { showError(err); }
  });
}

function openBatchForm(batch) {
  const isEdit = !!batch;
  const b = batch || { code: '', product: '', spec: '', units: '', roomId: state.rooms.length ? state.rooms[0].id : '', loadedAt: '', supplier: '', status: '在库', remark: '' };
  const body =
    '<div class="field"><label>批次号</label><input type="text" data-field="code" value="' + esc(b.code) + '"' + (isEdit ? ' disabled' : '') + '></div>' +
    '<div class="field"><label>品名</label><input type="text" data-field="product" value="' + esc(b.product) + '"></div>' +
    '<div class="field"><label>规格</label><input type="text" data-field="spec" value="' + esc(b.spec) + '"></div>' +
    '<div class="field"><label>件数</label><input type="number" step="1" data-field="units" value="' + esc(b.units) + '"></div>' +
    '<div class="field"><label>所在冷库/车厢</label><select data-field="roomId">' + roomOptions(b.roomId) + '</select></div>' +
    (isEdit ? '<div class="field"><label>换库位/换车时刻</label><input type="text" data-field="movedAt" value="" placeholder="不改设备就留空；改了设备必须填，如 2026-09-15 08:00:00"><div class="field-hint">改设备时老时段的占用账保留，从交接时刻起给新设备开账</div></div>' : '') +
    '<div class="field"><label>入库时刻</label><input type="text" data-field="loadedAt" value="' + esc(b.loadedAt) + '" placeholder="2026-09-01 08:00:00"></div>' +
    '<div class="field"><label>供应商</label><input type="text" data-field="supplier" value="' + esc(b.supplier) + '"></div>' +
    '<div class="field"><label>状态</label><select data-field="status">' + BATCH_STATUS.map(function (t) { return '<option value="' + esc(t) + '"' + (t === b.status ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join('') + '</select></div>' +
    '<div class="field"><label>备注</label><textarea data-field="remark">' + esc(b.remark) + '</textarea></div>';
  openModal(isEdit ? '修改批次' : '新增批次', body, isEdit ? '保存' : '新增', async function () {
    const v = formValues();
    const payload = {
      code: v.code, product: v.product, spec: v.spec, units: Number(v.units),
      roomId: v.roomId, loadedAt: v.loadedAt, supplier: v.supplier, status: v.status, remark: v.remark
    };
    if (isEdit && v.movedAt) payload.movedAt = v.movedAt;
    try {
      if (isEdit) await api('PATCH', '/api/batches/' + encodeURIComponent(batch.id), payload);
      else await api('POST', '/api/batches', payload);
      closeModal();
      await refreshAfterMutation();
    } catch (err) { showError(err); }
  });
}

function openOccupancyForm(row) {
  const isEdit = !!(row && row.id);
  const o = row || { batchId: state.batches.length ? state.batches[0].id : '', roomId: state.rooms.length ? state.rooms[0].id : '', probeId: '', startAt: '', endAt: '', remark: '' };
  const body =
    '<div class="field"><label>批次</label><select data-field="batchId">' + batchOptions(o.batchId) + '</select></div>' +
    '<div class="field"><label>设备（冷库/车厢）</label><select data-field="roomId">' + roomOptions(o.roomId) + '</select></div>' +
    '<div class="field"><label>探头（可留空，表示只占设备）</label><select data-field="probeId"><option value="">仅设备，不指定探头</option>' +
      state.probes.map(function (p) { return '<option value="' + esc(p.id) + '"' + (p.id === o.probeId ? ' selected' : '') + '>' + esc(p.code + '（' + (p.roomCode || '') + '）') + '</option>'; }).join('') + '</select></div>' +
    '<div class="field"><label>开始时刻</label><input type="text" data-field="startAt" value="' + esc(o.startAt) + '" placeholder="2026-09-14 23:00:00"></div>' +
    '<div class="field"><label>结束时刻（留空=占用中）</label><input type="text" data-field="endAt" value="' + esc(o.endAt) + '" placeholder="占用中就留空"></div>' +
    '<div class="field"><label>备注</label><textarea data-field="remark">' + esc(o.remark) + '</textarea></div>';
  openModal(isEdit ? '修改设备占用' : '登记设备占用', body, isEdit ? '保存' : '登记', async function () {
    const v = formValues();
    const payload = {
      batchId: v.batchId, roomId: v.roomId, probeId: v.probeId || '',
      startAt: v.startAt, endAt: v.endAt || '', remark: v.remark
    };
    try {
      if (isEdit) await api('PATCH', '/api/occupancies/' + encodeURIComponent(row.id), payload);
      else await api('POST', '/api/occupancies', payload);
      closeModal();
      await refreshAfterMutation();
    } catch (err) { showError(err); }
  });
}

function openSplitOccupancy(row) {
  const body =
    '<div class="field"><label>拆分时刻</label><input type="text" data-field="at" value="" placeholder="2026-09-15 00:00:00"><div class="field-hint">该时刻把占用切成两段，必须在 ' + esc(row.startAt) + ' 与 ' + esc(row.endAt || '现在') + ' 之间</div></div>' +
    '<div class="field"><label>后半段交给哪个批次</label><select data-field="toBatchId"><option value="">仍归 ' + esc(row.batchCode) + '</option>' +
      state.batches.map(function (b) { return '<option value="' + esc(b.id) + '">' + esc(b.code + ' ' + b.product) + '</option>'; }).join('') + '</select></div>';
  openModal('拆分占用时段', body, '拆分', async function () {
    const v = formValues();
    try {
      await api('POST', '/api/occupancies/' + encodeURIComponent(row.id) + '/split', { at: v.at, toBatchId: v.toBatchId || '' });
      closeModal();
      await refreshAfterMutation();
    } catch (err) { showError(err); }
  });
}

function openDecisionModal(batch, decision) {
  const body =
    '<div class="field"><label>经办人</label><input type="text" data-field="decider" value=""></div>' +
    '<div class="field"><label>依据</label><input type="text" data-field="basis" value=""></div>' +
    '<div class="field"><label>备注</label><textarea data-field="remark"></textarea></div>' +
    '<div class="field-hint">批次 ' + esc(batch.code) + '，本次决定：' + esc(decision) + '</div>';
  openModal(decision === '放行' ? '放行' : '拒收', body, decision, async function () {
    const v = formValues();
    try {
      await api('POST', '/api/batches/' + encodeURIComponent(batch.id) + '/decision', {
        decision: decision, decider: v.decider, basis: v.basis, remark: v.remark
      });
      closeModal();
      delete state.batchDetail[batch.id];
      delete state.batchOut[batch.id];
      await refreshAfterMutation();
    } catch (err) { showError(err); }
  });
}

function openRecordForm() {
  const now = state.summary && state.summary.today ? state.summary.today + ' 00:00:00' : '';
  const body =
    '<div class="field"><label>批次</label><select data-field="batchId" id="recFormBatch">' + batchOptions('') + '</select></div>' +
    '<div class="field"><label>探头</label><select data-field="probeId" id="recFormProbe">' + probeOptions('') + '</select></div>' +
    '<div class="field-hint" id="recFormHint"></div>' +
    '<div class="field"><label>时刻</label><input type="text" data-field="at" value="' + esc(now) + '" placeholder="2026-09-01 08:00:00"></div>' +
    '<div class="field"><label>温度（℃）</label><input type="number" step="0.1" data-field="temperatureC" value=""></div>' +
    '<div class="field"><label>来源</label><select data-field="source">' + SOURCE_LIST.map(function (t) { return '<option value="' + esc(t) + '">' + esc(t) + '</option>'; }).join('') + '</select></div>' +
    '<div class="field"><label>登记人</label><input type="text" data-field="operator" value=""></div>' +
    '<div class="field"><label>备注</label><textarea data-field="remark"></textarea></div>';
  openModal('新增温度记录', body, '新增', async function () {
    const v = formValues();
    const payload = {
      batchId: v.batchId, probeId: v.probeId, at: v.at,
      temperatureC: Number(v.temperatureC), source: v.source, operator: v.operator, remark: v.remark
    };
    try {
      const saved = await api('POST', '/api/records', payload);
      closeModal();
      await refreshAfterMutation();
      if (saved.attributionStatus === '存疑' || saved.attributionStatus === '账外归他') {
        showError({ message: '记录已保存，但归属是「' + saved.attributionStatus + '」：' + attrReasonText(saved.attributionReason) + (saved.resolvedBatchCode ? '（应归 ' + saved.resolvedBatchCode + '）' : '') });
      }
    } catch (err) { showError(err); }
  });
  setTimeout(function () {
    const update = function () {
      const b = state.batches.find(function (x) { return x.id === $('recFormBatch').value; });
      const p = state.probes.find(function (x) { return x.id === $('recFormProbe').value; });
      const hint = $('recFormHint');
      if (!b || !p) { hint.textContent = '批次和探头都选定后会核对设备是否一致。'; return; }
      if (b.roomId === p.roomId) hint.textContent = '批次与探头当前在同一设备，保存后正常归属。';
      else hint.textContent = '注意：该探头现在不在批次所在设备上，记录保存后很可能标「账外归他」或「存疑」，需在设备占用账上补交接。';
    };
    $('recFormBatch').addEventListener('change', update);
    $('recFormProbe').addEventListener('change', update);
    update();
  }, 0);
}

/* ---------- 变更后刷新 ---------- */

async function loadBase() {
  const results = await Promise.all([
    api('GET', '/api/rooms'),
    api('GET', '/api/probes'),
    api('GET', '/api/batches')
  ]);
  state.rooms = results[0];
  state.probes = results[1];
  state.batches = results[2];
}

async function refreshAfterMutation() {
  try { await loadBase(); } catch (err) { showError(err); }
  try {
    const s = await api('GET', '/api/summary');
    state.summary = s;
    $('todayText').textContent = s.today;
    renderOverview();
  } catch (err) { showError(err); }
  const exRooms = Array.from(state.expandedRooms);
  const exBatches = Array.from(state.expandedBatches);
  state.roomDetail = {};
  state.batchDetail = {};
  state.batchOut = {};
  state.batchDetailError = {};
  await loadView(state.view);
  for (let i = 0; i < exRooms.length; i += 1) {
    if (state.expandedRooms.has(exRooms[i])) {
      try { await expandRoom(exRooms[i]); } catch (err) { showError(err); }
    }
  }
  for (let j = 0; j < exBatches.length; j += 1) {
    if (state.expandedBatches.has(exBatches[j])) {
      try { await expandBatch(exBatches[j]); } catch (err) { showError(err); }
    }
  }
}

/* ---------- 交互总入口 ---------- */

function findRoom(id) { return state.rooms.find(function (r) { return r.id === id; }) || null; }
function findProbe(id) { return state.probes.find(function (p) { return p.id === id; }) || null; }
function findBatch(id) {
  return state.batches.find(function (b) { return b.id === id; }) ||
    (state.batchesView || []).find(function (b) { return b.id === id; }) || null;
}

async function handleAction(action, el) {
  try {
    if (action === 'open-settings') { openSettings(); return; }
    if (action === 'card-go') {
      const go = JSON.parse(el.dataset.go || '{}');
      if (go.view === 'rooms' && go.probeCal) state.filters.rooms.probeCal = go.probeCal;
      if (go.view === 'batches' && go.noRecord) state.filters.batches.noRecord = true;
      await switchView(go.view);
      return;
    }
    if (action === 'goto-room') {
      const id = el.dataset.roomId || el.dataset.id;
      await switchView('rooms');
      await expandRoom(id);
      return;
    }
    if (action === 'room-add') { openRoomForm(null); return; }
    if (action === 'room-edit') { openRoomForm(findRoom(el.dataset.id)); return; }
    if (action === 'room-del') {
      const id = el.dataset.id;
      armDelete(el, async function () {
        try {
          await api('DELETE', '/api/rooms/' + encodeURIComponent(id));
          delete state.roomDetail[id];
          state.expandedRooms.delete(id);
          await refreshAfterMutation();
        } catch (err) { showError(err); }
      });
      return;
    }
    if (action === 'probe-add') { openProbeForm(null); return; }
    if (action === 'probe-edit') { openProbeForm(findProbe(el.dataset.id)); return; }
    if (action === 'probe-del') {
      const id = el.dataset.id;
      armDelete(el, async function () {
        try {
          await api('DELETE', '/api/probes/' + encodeURIComponent(id));
          await refreshAfterMutation();
        } catch (err) { showError(err); }
      });
      return;
    }
    if (action === 'batch-release' || action === 'batch-reject') {
      const batch = findBatch(el.dataset.id);
      if (batch) openDecisionModal(batch, action === 'batch-release' ? '放行' : '拒收');
      return;
    }
    if (action === 'batch-add') { openBatchForm(null); return; }
    if (action === 'batch-edit') { openBatchForm(findBatch(el.dataset.id)); return; }
    if (action === 'occ-add') { openOccupancyForm(null); return; }
    if (action === 'occ-edit') { openOccupancyForm(findOccupancy(el.dataset.id)); return; }
    if (action === 'occ-split') { openSplitOccupancy(findOccupancy(el.dataset.id)); return; }
    if (action === 'occ-del') {
      const id = el.dataset.id;
      armDelete(el, async function () {
        try {
          await api('DELETE', '/api/occupancies/' + encodeURIComponent(id));
          await refreshAfterMutation();
        } catch (err) { showError(err); }
      });
      return;
    }
    if (action === 'occ-add-for') {
      const probe = findProbe(el.dataset.probe);
      openOccupancyForm({
        batchId: el.dataset.batch,
        roomId: probe ? probe.roomId : (state.rooms[0] && state.rooms[0].id),
        probeId: el.dataset.probe,
        startAt: el.dataset.at,
        endAt: '',
        remark: '为存疑记录补登记的探头占用'
      });
      return;
    }
    if (action === 'record-retag') {
      const id = el.dataset.id;
      const to = el.dataset.to;
      armDeleteText(el, '确认改挂', async function () {
        try {
          await api('PATCH', '/api/records/' + encodeURIComponent(id), { batchId: to });
          await refreshAfterMutation();
        } catch (err) { showError(err); }
      });
      return;
    }
    if (action === 'batch-del') {
      const id = el.dataset.id;
      armDelete(el, async function () {
        try {
          await api('DELETE', '/api/batches/' + encodeURIComponent(id));
          delete state.batchDetail[id];
          state.expandedBatches.delete(id);
          await refreshAfterMutation();
        } catch (err) { showError(err); }
      });
      return;
    }
    if (action === 'record-add') { openRecordForm(); return; }
    if (action === 'record-del') {
      const id = el.dataset.id;
      armDelete(el, async function () {
        try {
          await api('DELETE', '/api/records/' + encodeURIComponent(id));
          await refreshAfterMutation();
        } catch (err) { showError(err); }
      });
      return;
    }
  } catch (err) { showError(err); }
}

async function toggleExpand(kind, id) {
  try {
    if (kind === 'room') {
      if (state.expandedRooms.has(id)) { state.expandedRooms.delete(id); renderRoomRows(); }
      else await expandRoom(id);
      return;
    }
    if (kind === 'batch') {
      if (state.expandedBatches.has(id)) { state.expandedBatches.delete(id); renderBatchRows(); }
      else await expandBatch(id);
    }
  } catch (err) { showError(err); }
}

document.body.addEventListener('click', function (e) {
  const tab = e.target.closest('.tab');
  if (tab && tab.dataset.view) { switchView(tab.dataset.view); return; }

  const actionEl = e.target.closest('[data-action]');
  if (actionEl) { handleAction(actionEl.dataset.action, actionEl); return; }

  const row = e.target.closest('tr.row-main');
  if (row && row.dataset.rowkind) { toggleExpand(row.dataset.rowkind, row.dataset.id); }
});

$('filters').addEventListener('change', onFilterInput);
$('filters').addEventListener('input', onFilterInput);

$('modalClose').addEventListener('click', closeModal);
$('modalCancel').addEventListener('click', closeModal);
$('modalOk').addEventListener('click', function () {
  if (modalOnOk) modalOnOk();
});
$('modalMask').addEventListener('click', function (e) {
  if (e.target === $('modalMask')) closeModal();
});

/* ---------- 启动 ---------- */

async function boot() {
  try {
    const results = await Promise.all([
      api('GET', '/api/summary'),
      api('GET', '/api/settings'),
      api('GET', '/api/rooms'),
      api('GET', '/api/probes'),
      api('GET', '/api/batches')
    ]);
    state.summary = results[0];
    state.settings = results[1];
    state.rooms = results[2];
    state.probes = results[3];
    state.batches = results[4];
    $('todayText').textContent = state.summary.today;
    renderOverview();
  } catch (err) { showError(err); }

  renderFilters();
  await loadView(state.view);
}

boot();
