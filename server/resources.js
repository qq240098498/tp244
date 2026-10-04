const { AppError } = require('./errors');
const store = require('./store');
const coldlib = require('./coldlib');
const attribution = require('./attribution');

const ROOM_STATUS = ['运行', '检修', '停用'];
const ROOM_TYPE = ['冷藏库', '冷藏车', '冷冻库'];
const PROBE_STATUS = ['在用', '停用', '送检'];
const BATCH_STATUS = ['在库', '待放行', '已放行', '已拒收'];
const SOURCE_LIST = ['自动', '人工'];
const OVERLAP_POLICIES = ['window', 'first', 'manual'];
const BOUNDARY_POLICIES = ['front', 'back'];

function roomCode(data, id) {
  const room = data.rooms.find((r) => r.id === id);
  return room ? room.code : '';
}
function batchCode(data, id) {
  const batch = data.batches.find((b) => b.id === id);
  return batch ? batch.code : '';
}
function probeCode(data, id) {
  const probe = data.probes.find((p) => p.id === id);
  return probe ? probe.code : '';
}

function decorateRoom(data, room) {
  const probes = data.probes.filter((p) => p.roomId === room.id);
  const batches = data.batches.filter((b) => b.roomId === room.id);
  return Object.assign({}, room, {
    probeCount: probes.length,
    runningProbeCount: probes.filter((p) => p.status === '在用').length,
    batchCount: batches.length,
    openBatchCount: batches.filter((b) => b.status === '在库' || b.status === '待放行').length,
  });
}

function decorateProbe(data, probe) {
  const records = data.records.filter((r) => r.probeId === probe.id);
  return Object.assign({}, probe, {
    roomCode: roomCode(data, probe.roomId),
    recordCount: records.length,
    manualCount: records.filter((r) => r.source === '人工').length,
    expired: !coldlib.probeValidOn(probe, store.nowText().slice(0, 10)),
  });
}

function decorateBatch(data, batch) {
  const stats = coldlib.excursionStats(data, batch.id);
  const check = coldlib.releaseCheck(data, batch);
  const releases = data.releases.filter((r) => r.batchId === batch.id);
  return Object.assign({}, batch, {
    roomCode: roomCode(data, batch.roomId),
    recordCount: stats.recordCount,
    longestExcursionMinutes: stats.longestMinutes,
    totalExcursionMinutes: stats.totalMinutes,
    mkt: check.mkt,
    chainGapCount: check.chain.gapCount,
    expiredProbeCodes: check.expiredProbes.map((p) => p.probeCode),
    attributionProblemCount: check.attributionProblems.total,
    releaseCheck: check,
    releaseCount: releases.length,
    lastDecision: releases.length ? releases[releases.length - 1].decision : '',
  });
}

/* ---------- 设备占用账与人工改判 ---------- */

function decorateOccupancy(data, occ) {
  const map = attribution.mapFor(data);
  let attributed = 0;
  let disputed = 0;
  for (const r of data.records) {
    if (r.probeId !== occ.probeId) continue;
    const a = map.get(r.id);
    if (!a) continue;
    if (a.occupancyId === occ.id && a.counted) attributed += 1;
    if (!a.counted && a.hitOccupancyIds.indexOf(occ.id) >= 0) disputed += 1;
  }
  return Object.assign({}, occ, {
    batchCode: batchCode(data, occ.batchId),
    roomCode: roomCode(data, occ.roomId),
    probeCode: occ.probeId ? probeCode(data, occ.probeId) : '',
    active: occ.endAt === '',
    attributedRecordCount: attributed,
    disputedRecordCount: disputed,
  });
}

function attributionInfo(data, record) {
  const a = attribution.mapFor(data).get(record.id);
  if (!a) return null;
  const override = data.attributionOverrides.find((o) => o.recordId === record.id && !o.revokedAt && !o.supersededAt);
  return {
    status: a.status,
    statusText: attribution.STATUS_TEXT[a.status] || a.status,
    counted: a.counted,
    boundary: a.boundary,
    occupancyId: a.occupancyId,
    chargedBatchId: a.chargedBatchId,
    chargedBatchCode: a.chargedBatchId ? batchCode(data, a.chargedBatchId) : '',
    hitOccupancyIds: a.hitOccupancyIds,
    overrideId: override ? override.id : '',
    basis: a.basis,
  };
}

function listOccupancies(data, query) {
  const q = query || {};
  let rows = data.occupancies.slice();
  if (q.batchId) rows = rows.filter((w) => w.batchId === q.batchId);
  if (q.roomId) rows = rows.filter((w) => w.roomId === q.roomId);
  if (q.probeId) rows = rows.filter((w) => w.probeId === q.probeId);
  if (q.active === 'true') rows = rows.filter((w) => w.endAt === '');
  if (q.active === 'false') rows = rows.filter((w) => w.endAt !== '');
  return rows.map((w) => decorateOccupancy(data, w))
    .sort((a, b) => (a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : (a.id < b.id ? -1 : 1)));
}

const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function validateOccupancy(data, payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!data.batches.some((b) => b.id === merged.batchId)) errors.batchId = '批次不存在';
  if (!data.rooms.some((r) => r.id === merged.roomId)) errors.roomId = '设备（冷库/车厢）不存在';
  if (merged.probeId) {
    if (!data.probes.some((p) => p.id === merged.probeId)) errors.probeId = '探头不存在';
  }
  if (!TIME_RE.test(String(merged.startAt || ''))) errors.startAt = '开始时刻格式要像 2026-09-14 05:00:00';
  if (merged.endAt) {
    if (!TIME_RE.test(String(merged.endAt))) errors.endAt = '结束时刻格式要像 2026-09-14 12:00:00，留空表示进行中';
    else if (String(merged.endAt) <= String(merged.startAt)) errors.endAt = '结束时刻要晚于开始时刻';
  }
  if (current && payload.batchId !== undefined && payload.batchId !== current.batchId) {
    errors.batchId = '占用窗的批次不能改，要换批次请新开一条';
  }
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '占用账没通过校验', errors);
}

function createOccupancy(data, payload) {
  validateOccupancy(data, payload, null);
  const occ = {
    id: store.nextId('oc', data.occupancies),
    batchId: payload.batchId,
    roomId: payload.roomId,
    probeId: payload.probeId || '',
    startAt: String(payload.startAt),
    endAt: payload.endAt ? String(payload.endAt) : '',
    purpose: String(payload.purpose || '').trim(),
    remark: String(payload.remark || '').trim(),
  };
  data.occupancies.push(occ);
  attribution.invalidate(data);
  return decorateOccupancy(data, occ);
}

function updateOccupancy(data, id, payload) {
  const occ = data.occupancies.find((w) => w.id === id);
  if (!occ) throw new AppError(404, 'OCCUPANCY_NOT_FOUND', '这条设备占用不存在');
  validateOccupancy(data, payload, occ);
  const merged = Object.assign({}, occ, payload);
  Object.assign(occ, {
    roomId: merged.roomId,
    probeId: merged.probeId || '',
    startAt: String(merged.startAt),
    endAt: merged.endAt ? String(merged.endAt) : '',
    purpose: String(merged.purpose || '').trim(),
    remark: String(merged.remark || '').trim(),
  });
  attribution.invalidate(data);
  return decorateOccupancy(data, occ);
}

// 删占用窗不拦：窗删掉后记录会重算成占用窗外/存疑，账要如实变。
// 指向这条窗的生效改判随窗软撤销，留痕。
function removeOccupancy(data, id) {
  const occ = data.occupancies.find((w) => w.id === id);
  if (!occ) throw new AppError(404, 'OCCUPANCY_NOT_FOUND', '这条设备占用不存在');
  let revoked = 0;
  for (const o of data.attributionOverrides) {
    if (!o.revokedAt && !o.supersededAt && o.kind === 'assign' && o.occupancyId === id) {
      o.revokedAt = store.nowText();
      o.revokedBy = '系统';
      o.revokedReason = '占用窗已删除';
      revoked += 1;
    }
  }
  data.occupancies = data.occupancies.filter((w) => w.id !== id);
  attribution.invalidate(data);
  return { removed: id, revokedOverrideCount: revoked };
}

function decorateOverride(data, o) {
  const record = data.records.find((r) => r.id === o.recordId);
  const occ = data.occupancies.find((w) => w.id === o.occupancyId);
  return Object.assign({}, o, {
    active: !o.revokedAt && !o.supersededAt,
    recordAt: record ? record.at : '',
    probeCode: record ? probeCode(data, record.probeId) : '',
    batchCode: record ? batchCode(data, record.batchId) : '',
    occupancyBatchCode: occ ? batchCode(data, occ.batchId) : '',
  });
}

function listOverrides(data, query) {
  const q = query || {};
  let rows = data.attributionOverrides.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (q.recordId) rows = rows.filter((o) => o.recordId === q.recordId);
  if (q.active === 'true') rows = rows.filter((o) => !o.revokedAt && !o.supersededAt);
  if (q.active === 'false') rows = rows.filter((o) => o.revokedAt || o.supersededAt);
  return rows.map((o) => decorateOverride(data, o));
}

function createOverride(data, payload) {
  const errors = {};
  const record = data.records.find((r) => r.id === payload.recordId);
  if (!record) errors.recordId = '温度记录不存在';
  if (!['assign', 'exclude'].includes(payload.kind)) errors.kind = '改判只能是 assign（计入某占用）或 exclude（剔除）';
  if (!String(payload.operator || '').trim()) errors.operator = '操作人要填';
  if (!String(payload.reason || '').trim()) errors.reason = '改判理由要填';
  let occ = null;
  if (payload.kind === 'assign') {
    occ = data.occupancies.find((w) => w.id === payload.occupancyId);
    if (!occ) errors.occupancyId = '改判目标占用窗不存在';
    else if (record && occ.probeId !== record.probeId) errors.occupancyId = '改判占用窗必须是同一台探头';
  }
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '改判没通过校验', errors);

  // 同一条记录只保留一条生效改判，旧的标 superseded 留痕
  for (const old of data.attributionOverrides) {
    if (old.recordId === payload.recordId && !old.revokedAt && !old.supersededAt) old.supersededAt = store.nowText();
  }
  const override = {
    id: store.nextId('ao', data.attributionOverrides),
    recordId: payload.recordId,
    kind: payload.kind,
    occupancyId: payload.kind === 'assign' ? occ.id : '',
    reason: String(payload.reason).trim(),
    operator: String(payload.operator).trim(),
    createdAt: store.nowText(),
    revokedAt: '',
    revokedBy: '',
    revokedReason: '',
    supersededAt: '',
  };
  data.attributionOverrides.push(override);
  attribution.invalidate(data);
  return decorateOverride(data, override);
}

function revokeOverride(data, id, payload) {
  const override = data.attributionOverrides.find((o) => o.id === id);
  if (!override) throw new AppError(404, 'OVERRIDE_NOT_FOUND', '这条改判不存在');
  if (override.revokedAt || override.supersededAt) throw new AppError(409, 'OVERRIDE_INACTIVE', '这条改判已经撤销或被新改判替代');
  override.revokedAt = store.nowText();
  override.revokedBy = String((payload && payload.operator) || '').trim() || '值班员';
  override.revokedReason = String((payload && payload.reason) || '').trim();
  attribution.invalidate(data);
  return { revoked: id, revokedAt: override.revokedAt };
}


function listRooms(data, query) {
  const q = query || {};
  let rows = data.rooms.slice();
  if (q.status) rows = rows.filter((r) => r.status === q.status);
  if (q.type) rows = rows.filter((r) => r.type === q.type);
  if (q.keyword) {
    const kw = String(q.keyword).toLowerCase();
    rows = rows.filter((r) => [r.code, r.name, r.location].some((f) => String(f || '').toLowerCase().includes(kw)));
  }
  return rows.map((r) => decorateRoom(data, r)).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function roomDetail(data, id) {
  const room = data.rooms.find((r) => r.id === id);
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', '这个冷库或者车厢不存在');
  return Object.assign({}, decorateRoom(data, room), {
    probes: data.probes.filter((p) => p.roomId === id).map((p) => decorateProbe(data, p)),
    batches: data.batches.filter((b) => b.roomId === id).map((b) => decorateBatch(data, b)),
  });
}

function validateRoom(payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '编码不能为空';
  if (!String(merged.name || '').trim()) errors.name = '名称不能为空';
  if (!ROOM_TYPE.includes(merged.type)) errors.type = '类型只能是：' + ROOM_TYPE.join('、');
  if (!ROOM_STATUS.includes(merged.status)) errors.status = '状态只能是：' + ROOM_STATUS.join('、');
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有项目没通过校验', errors);
}

function createRoom(data, payload) {
  validateRoom(payload, null);
  const room = {
    id: store.nextId('rm', data.rooms),
    code: String(payload.code).trim(),
    name: String(payload.name).trim(),
    type: payload.type,
    location: String(payload.location || '').trim(),
    capacityPlt: Number(payload.capacityPlt) || 0,
    status: payload.status,
    remark: String(payload.remark || ''),
  };
  data.rooms.push(room);
  return decorateRoom(data, room);
}

function updateRoom(data, id, payload) {
  const room = data.rooms.find((r) => r.id === id);
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', '这个冷库或者车厢不存在');
  validateRoom(payload, room);
  const merged = Object.assign({}, room, payload);
  Object.assign(room, {
    name: String(merged.name).trim(),
    type: merged.type,
    location: String(merged.location || '').trim(),
    capacityPlt: Number(merged.capacityPlt) || 0,
    status: merged.status,
    remark: String(merged.remark || ''),
  });
  return decorateRoom(data, room);
}

function removeRoom(data, id) {
  const room = data.rooms.find((r) => r.id === id);
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', '这个冷库或者车厢不存在');
  const used = data.probes.filter((p) => p.roomId === id).length +
    data.batches.filter((b) => b.roomId === id).length +
    data.occupancies.filter((w) => w.roomId === id).length;
  if (used > 0) throw new AppError(409, 'ROOM_IN_USE', '名下还有 ' + used + ' 条探头、批次或者设备占用，不能删除', { count: used });
  data.rooms = data.rooms.filter((r) => r.id !== id);
  return { removed: id };
}

function listProbes(data, query) {
  const q = query || {};
  let rows = data.probes.slice();
  if (q.roomId) rows = rows.filter((p) => p.roomId === q.roomId);
  if (q.status) rows = rows.filter((p) => p.status === q.status);
  return rows.map((p) => decorateProbe(data, p)).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function validateProbe(data, payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '编号不能为空';
  if (!data.rooms.some((r) => r.id === merged.roomId)) errors.roomId = '所属冷库不存在';
  if (!PROBE_STATUS.includes(merged.status)) errors.status = '状态只能是：' + PROBE_STATUS.join('、');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(merged.calibratedUntil || ''))) errors.calibratedUntil = '校准有效期要像 2026-12-31';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有几项没通过校验', errors);
}

function createProbe(data, payload) {
  validateProbe(data, payload, null);
  const probe = {
    id: store.nextId('pb', data.probes),
    code: String(payload.code).trim(),
    roomId: payload.roomId,
    position: String(payload.position || '').trim(),
    status: payload.status,
    calibratedUntil: String(payload.calibratedUntil),
    remark: String(payload.remark || ''),
  };
  data.probes.push(probe);
  return decorateProbe(data, probe);
}

function updateProbe(data, id, payload) {
  const probe = data.probes.find((p) => p.id === id);
  if (!probe) throw new AppError(404, 'PROBE_NOT_FOUND', '这个探头不存在');
  validateProbe(data, payload, probe);
  const merged = Object.assign({}, probe, payload);
  Object.assign(probe, {
    roomId: merged.roomId,
    position: String(merged.position || '').trim(),
    status: merged.status,
    calibratedUntil: String(merged.calibratedUntil),
    remark: String(merged.remark || ''),
  });
  return decorateProbe(data, probe);
}

function removeProbe(data, id) {
  const probe = data.probes.find((p) => p.id === id);
  if (!probe) throw new AppError(404, 'PROBE_NOT_FOUND', '这个探头不存在');
  const used = data.records.filter((r) => r.probeId === id).length;
  const occUsed = data.occupancies.filter((w) => w.probeId === id).length;
  if (used > 0 || occUsed > 0) {
    throw new AppError(409, 'PROBE_IN_USE', '这个探头名下还有 ' + used + ' 条温度记录、' + occUsed + ' 条设备占用，不能删除', { recordCount: used, occupancyCount: occUsed });
  }
  data.probes = data.probes.filter((p) => p.id !== id);
  return { removed: id };
}

function listBatches(data, query) {
  const q = query || {};
  let rows = data.batches.slice();
  if (q.roomId) rows = rows.filter((b) => b.roomId === q.roomId);
  if (q.status) rows = rows.filter((b) => b.status === q.status);
  if (q.product) rows = rows.filter((b) => String(b.product || '').includes(q.product));
  const decorated = rows.map((b) => decorateBatch(data, b));
  return decorated.sort((a, b) => (a.loadedAt < b.loadedAt ? 1 : -1));
}

function batchDetail(data, id) {
  const batch = data.batches.find((b) => b.id === id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  const rows = coldlib.recordsOfBatch(data, id).map((r) => Object.assign({}, r, {
    probeCode: probeCode(data, r.probeId),
    probeExpired: !coldlib.probeValidOn(coldlib.probeOf(data, r.probeId), String(r.at).slice(0, 10)),
    attribution: attributionInfo(data, r),
  }));
  const problems = attribution.problemRecords(data, id).map(function (item) {
    return Object.assign({}, item.record, {
      probeCode: probeCode(data, item.record.probeId),
      attribution: Object.assign({}, item.attribution, { statusText: attribution.STATUS_TEXT[item.attribution.status] || item.attribution.status }),
    });
  });
  const occupancies = data.occupancies
    .filter((w) => w.batchId === id)
    .map((w) => decorateOccupancy(data, w))
    .sort((a, b) => (a.startAt < b.startAt ? -1 : 1));
  return Object.assign({}, decorateBatch(data, batch), {
    records: rows,
    effectiveRecords: coldlib.effectiveRecords(data, id).map((r) => Object.assign({}, r, {
      probeCode: probeCode(data, r.probeId),
      attribution: attributionInfo(data, r),
    })),
    segments: coldlib.excursionStats(data, id).segments,
    chainGaps: coldlib.chainGaps(data, id).gaps,
    occupancies,
    problemRecords: problems,
    releases: data.releases.filter((r) => r.batchId === id).slice().sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1)),
  });
}

function validateBatch(data, payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '批次号不能为空';
  if (!String(merged.product || '').trim()) errors.product = '品名不能为空';
  if (!data.rooms.some((r) => r.id === merged.roomId)) errors.roomId = '所在冷库不存在';
  if (!BATCH_STATUS.includes(merged.status)) errors.status = '状态只能是：' + BATCH_STATUS.join('、');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(merged.loadedAt || ''))) errors.loadedAt = '入库时刻格式要像 2026-09-01 08:00:00';
  const units = Number(merged.units);
  if (!Number.isFinite(units) || units <= 0) errors.units = '件数要是大于零的数';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有几项没通过校验', errors);
}

function createBatch(data, payload) {
  validateBatch(data, payload, null);
  const batch = {
    id: store.nextId('bt', data.batches),
    code: String(payload.code).trim(),
    product: String(payload.product).trim(),
    spec: String(payload.spec || '').trim(),
    units: Number(payload.units),
    roomId: payload.roomId,
    loadedAt: String(payload.loadedAt),
    supplier: String(payload.supplier || '').trim(),
    status: payload.status,
    remark: String(payload.remark || ''),
  };
  data.batches.push(batch);
  return decorateBatch(data, batch);
}

function updateBatch(data, id, payload) {
  const batch = data.batches.find((b) => b.id === id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  validateBatch(data, payload, batch);
  const merged = Object.assign({}, batch, payload);
  Object.assign(batch, {
    product: String(merged.product).trim(),
    spec: String(merged.spec || '').trim(),
    units: Number(merged.units),
    roomId: merged.roomId,
    loadedAt: String(merged.loadedAt),
    supplier: String(merged.supplier || '').trim(),
    status: merged.status,
    remark: String(merged.remark || ''),
  });
  return decorateBatch(data, batch);
}

function removeBatch(data, id) {
  const batch = data.batches.find((b) => b.id === id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  if (batch.status === '已放行') throw new AppError(409, 'BATCH_RELEASED', '这个批次已经放行，不能直接删除', { code: batch.code });
  const recordIds = new Set(data.records.filter((r) => r.batchId === id).map((r) => r.id));
  const occIds = new Set(data.occupancies.filter((w) => w.batchId === id).map((w) => w.id));
  const used = recordIds.size;
  const removedOccupancies = occIds.size;
  // 指向被删占用窗的改判软撤销；指向被删记录的改判硬删（审计对象已不存在）
  let revokedOverrides = 0;
  data.attributionOverrides = data.attributionOverrides.filter((o) => {
    if (recordIds.has(o.recordId)) return false;
    if (o.kind === 'assign' && occIds.has(o.occupancyId) && !o.revokedAt && !o.supersededAt) {
      o.revokedAt = store.nowText();
      o.revokedBy = '系统';
      o.revokedReason = '批次与占用窗已删除';
      revokedOverrides += 1;
    }
    return true;
  });
  data.records = data.records.filter((r) => r.batchId !== id);
  data.occupancies = data.occupancies.filter((w) => w.batchId !== id);
  data.releases = data.releases.filter((r) => r.batchId !== id);
  data.batches = data.batches.filter((b) => b.id !== id);
  attribution.invalidate(data);
  return { removed: id, removedRecords: used, removedOccupancies, revokedOverrides };
}

const PROBLEM_STATUS = ['disputed', 'out-of-window', 'device-mismatch', 'wrong-batch', 'manual-excluded'];

function listRecords(data, query) {
  const q = query || {};
  let rows = data.records.slice();
  if (q.batchId) rows = rows.filter((r) => r.batchId === q.batchId);
  if (q.probeId) rows = rows.filter((r) => r.probeId === q.probeId);
  if (q.source) rows = rows.filter((r) => r.source === q.source);
  if (q.from) rows = rows.filter((r) => r.at >= q.from);
  if (q.to) rows = rows.filter((r) => r.at <= q.to);
  let decorated = rows
    .map((r) => Object.assign({}, r, {
      batchCode: batchCode(data, r.batchId),
      probeCode: probeCode(data, r.probeId),
      outOfRange: Number(r.temperatureC) > Number(data.settings.upperLimitC) || Number(r.temperatureC) < Number(data.settings.lowerLimitC),
      attribution: attributionInfo(data, r),
    }))
    .sort((a, b) => (a.at < b.at ? 1 : -1));
  if (q.status) decorated = decorated.filter((r) => r.attribution && r.attribution.status === q.status);
  if (q.onlyProblems === 'true') decorated = decorated.filter((r) => r.attribution && PROBLEM_STATUS.indexOf(r.attribution.status) >= 0);
  return decorated;
}

function validateRecord(data, payload) {
  const errors = {};
  const batch = data.batches.find((b) => b.id === payload.batchId);
  if (!batch) errors.batchId = '批次不存在';
  const probe = data.probes.find((p) => p.id === payload.probeId);
  if (!probe) errors.probeId = '探头不存在';
  if (!SOURCE_LIST.includes(payload.source)) errors.source = '来源只能是：' + SOURCE_LIST.join('、');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(payload.at || ''))) errors.at = '记录时刻格式要像 2026-09-01 08:00:00';
  if (payload.temperatureC === undefined || payload.temperatureC === '') errors.temperatureC = '温度不能为空';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '这条温度记录没通过校验', errors);
  return { batch, probe };
}

function createRecord(data, payload) {
  validateRecord(data, payload);
  const record = {
    id: store.nextId('rc', data.records),
    batchId: payload.batchId,
    probeId: payload.probeId,
    at: String(payload.at),
    temperatureC: Number(payload.temperatureC),
    source: payload.source,
    operator: String(payload.operator || '').trim(),
    remark: String(payload.remark || ''),
  };
  data.records.push(record);
  attribution.invalidate(data);
  return Object.assign({}, record, { batchCode: batchCode(data, record.batchId), probeCode: probeCode(data, record.probeId) });
}

function removeRecord(data, id) {
  const record = data.records.find((r) => r.id === id);
  if (!record) throw new AppError(404, 'RECORD_NOT_FOUND', '这条温度记录不存在');
  data.attributionOverrides = data.attributionOverrides.filter((o) => o.recordId !== id);
  data.records = data.records.filter((r) => r.id !== id);
  attribution.invalidate(data);
  return { removed: id };
}

function listReleases(data, query) {
  const q = query || {};
  let rows = data.releases.slice();
  if (q.batchId) rows = rows.filter((r) => r.batchId === q.batchId);
  if (q.decision) rows = rows.filter((r) => r.decision === q.decision);
  return rows
    .map((r) => Object.assign({}, r, { batchCode: batchCode(data, r.batchId) }))
    .sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1));
}

// 放行：登记放行单并改批次状态
function decide(data, batchId, payload) {
  const batch = data.batches.find((b) => b.id === batchId);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  if (!['放行', '拒收'].includes(payload.decision)) {
    throw new AppError(400, 'VALIDATION_FAILED', '决定只能是放行或者拒收', { decision: '请选择放行或者拒收' });
  }
  if (!String(payload.decider || '').trim()) {
    throw new AppError(400, 'VALIDATION_FAILED', '经办人要填', { decider: '经办人不能为空' });
  }
  const check = coldlib.releaseCheck(data, batch);
  const release = {
    id: store.nextId('rl', data.releases),
    batchId: batch.id,
    decision: payload.decision,
    decidedAt: String(payload.decidedAt || store.nowText()),
    decider: String(payload.decider).trim(),
    mkt: check.mkt,
    longestExcursionMinutes: check.longestMinutes,
    totalExcursionMinutes: check.totalMinutes,
    chainGapCount: check.chain.gapCount,
    attributionProblemCount: check.attributionProblems.total,
    basis: String(payload.basis || '').trim(),
    remark: String(payload.remark || ''),
  };
  data.releases.push(release);
  batch.status = payload.decision === '放行' ? '已放行' : '已拒收';
  batch.decidedAt = release.decidedAt;
  return { release, batch: decorateBatch(data, batch) };
}

module.exports = {
  listRooms, roomDetail, createRoom, updateRoom, removeRoom,
  listProbes, createProbe, updateProbe, removeProbe,
  listBatches, batchDetail, createBatch, updateBatch, removeBatch,
  listRecords, createRecord, removeRecord,
  listReleases, decide,
  listOccupancies, createOccupancy, updateOccupancy, removeOccupancy,
  listOverrides, createOverride, revokeOverride,
  ROOM_STATUS, ROOM_TYPE, PROBE_STATUS, BATCH_STATUS, SOURCE_LIST,
  OVERLAP_POLICIES, BOUNDARY_POLICIES,
};
