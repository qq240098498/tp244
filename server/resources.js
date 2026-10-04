const { AppError } = require('./errors');
const store = require('./store');
const coldlib = require('./coldlib');

const ROOM_STATUS = ['运行', '检修', '停用'];
const ROOM_TYPE = ['冷藏库', '冷藏车', '冷冻库'];
const PROBE_STATUS = ['在用', '停用', '送检'];
const BATCH_STATUS = ['在库', '待放行', '已放行', '已拒收'];
const SOURCE_LIST = ['自动', '人工'];

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
    unresolvedCount: check.attribution.unresolvedCount,
    misTaggedCount: check.attribution.misTaggedCount,
    releaseCheck: check,
    releaseCount: releases.length,
    lastDecision: releases.length ? releases[releases.length - 1].decision : '',
  });
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
  const used = data.probes.filter((p) => p.roomId === id).length + data.batches.filter((b) => b.roomId === id).length;
  if (used > 0) throw new AppError(409, 'ROOM_IN_USE', '名下还有 ' + used + ' 条探头或者批次，不能删除', { count: used });
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
  if (used > 0) throw new AppError(409, 'PROBE_IN_USE', '这个探头名下还有 ' + used + ' 条温度记录，不能删除', { count: used });
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
  const amap = coldlib.attributionMap(data);
  const rows = coldlib.recordsOfBatch(data, id).map((r) => Object.assign({}, r, {
    probeCode: probeCode(data, r.probeId),
    probeExpired: !coldlib.probeValidOn(coldlib.probeOf(data, r.probeId), String(r.at).slice(0, 10)),
    attributionStatus: amap[r.id] ? amap[r.id].status : '',
    attributionReason: amap[r.id] ? amap[r.id].reason : '',
    resolvedBatchId: amap[r.id] ? amap[r.id].resolvedBatchId : null,
    resolvedBatchCode: amap[r.id] && amap[r.id].resolvedBatchId ? batchCode(data, amap[r.id].resolvedBatchId) : '',
  }));
  const attribution = coldlib.batchAttribution(data, id);
  return Object.assign({}, decorateBatch(data, batch), {
    records: rows,
    effectiveRecords: coldlib.effectiveRecords(data, id).map((r) => Object.assign({}, r, { probeCode: probeCode(data, r.probeId) })),
    segments: coldlib.excursionStats(data, id).segments,
    chainGaps: coldlib.chainGaps(data, id).gaps,
    occupancies: attribution.occupancies.map((o) => coldlib.decorateOccupancy(data, o)),
    attribution: {
      taggedCount: attribution.taggedCount,
      claimedInCount: attribution.claimedInCount,
      misTaggedCount: attribution.misTaggedCount,
      unresolvedCount: attribution.unresolvedCount,
      claimedIn: attribution.claimedIn.map((r) => ({
        id: r.id, probeId: r.probeId, probeCode: probeCode(data, r.probeId), at: r.at,
        temperatureC: r.temperatureC, source: r.source, taggedBatchCode: batchCode(data, r.batchId),
      })),
      misTagged: attribution.tagged
        .filter((r) => r.attribution.resolvedBatchId && r.attribution.resolvedBatchId !== id)
        .map((r) => ({
          id: r.id, probeId: r.probeId, probeCode: probeCode(data, r.probeId), at: r.at,
          temperatureC: r.temperatureC, source: r.source,
          resolvedBatchId: r.attribution.resolvedBatchId, resolvedBatchCode: batchCode(data, r.attribution.resolvedBatchId),
          reason: r.attribution.reason,
        })),
      unresolved: attribution.unresolved.map((r) => ({
        id: r.id, probeId: r.probeId, probeCode: probeCode(data, r.probeId), at: r.at,
        temperatureC: r.temperatureC, source: r.source, reason: r.attribution.reason,
      })),
      overlaps: attribution.overlaps.map((w) => Object.assign({}, w, {
        probeCode: probeCode(data, w.probeId),
        order: w.order.map((bid) => ({ batchId: bid, batchCode: batchCode(data, bid) })),
        slices: w.slices ? w.slices.map((s) => ({
          batchId: s.batchId, batchCode: batchCode(data, s.batchId), startAt: s.startAt, endAt: s.endAt,
        })) : null,
      })),
    },
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
  data.occupancies.push({
    id: store.nextId('oc', data.occupancies),
    batchId: batch.id,
    roomId: batch.roomId,
    probeId: '',
    startAt: batch.loadedAt,
    endAt: '',
    source: 'auto',
    remark: '新建批次自动开账',
  });
  coldlib.invalidateAttribution(data);
  return decorateBatch(data, batch);
}

// 收口某批次在指定时刻仍开口的占用行
function closeOpenOccupancies(data, batchId, at) {
  for (const o of data.occupancies) {
    if (o.batchId === batchId && !o.endAt && o.startAt <= String(at)) o.endAt = String(at);
  }
}

function updateBatch(data, id, payload) {
  const batch = data.batches.find((b) => b.id === id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  // 换库位/换车厢必须给出交接时刻，旧占用段保留留痕
  if (payload.roomId && payload.roomId !== batch.roomId && !payload.movedAt) {
    throw new AppError(400, 'VALIDATION_FAILED', '批次换了库位或者车厢，必须填交接时刻，老时段的占用要保留在账上', { movedAt: '请填写换库位/换车时刻（格式 2026-09-01 08:00:00）' });
  }
  validateBatch(data, payload, batch);
  if (payload.movedAt !== undefined && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(payload.movedAt || ''))) {
    throw new AppError(400, 'VALIDATION_FAILED', '交接时刻格式不对', { movedAt: '格式要像 2026-09-01 08:00:00' });
  }
  const merged = Object.assign({}, batch, payload);
  const roomChanged = merged.roomId !== batch.roomId;
  const movedAt = payload.movedAt ? String(payload.movedAt) : store.nowText();
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
  if (roomChanged) {
    closeOpenOccupancies(data, id, movedAt);
    data.occupancies.push({
      id: store.nextId('oc', data.occupancies),
      batchId: id,
      roomId: batch.roomId,
      probeId: '',
      startAt: movedAt,
      endAt: '',
      source: 'auto',
      remark: '批次换库位/换车自动开账',
    });
    coldlib.invalidateAttribution(data);
  }
  return decorateBatch(data, batch);
}

function removeBatch(data, id) {
  const batch = data.batches.find((b) => b.id === id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  if (batch.status === '已放行') throw new AppError(409, 'BATCH_RELEASED', '这个批次已经放行，不能直接删除', { code: batch.code });
  const used = data.records.filter((r) => r.batchId === id).length;
  data.records = data.records.filter((r) => r.batchId !== id);
  data.releases = data.releases.filter((r) => r.batchId !== id);
  data.occupancies = data.occupancies.filter((o) => o.batchId !== id);
  coldlib.invalidateAttribution(data);
  data.batches = data.batches.filter((b) => b.id !== id);
  return { removed: id, removedRecords: used };
}

/* ---------- 设备占用账 ---------- */

const OCCUPANCY_SOURCE = ['auto', 'manual'];

function validateOccupancy(data, payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!data.batches.some((b) => b.id === merged.batchId)) errors.batchId = '批次不存在';
  if (!data.rooms.some((r) => r.id === merged.roomId)) errors.roomId = '设备（冷库/车厢）不存在';
  if (merged.probeId && !data.probes.some((p) => p.id === merged.probeId)) errors.probeId = '探头不存在';
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(merged.startAt || ''))) errors.startAt = '开始时刻格式要像 2026-09-01 08:00:00';
  if (merged.endAt && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(merged.endAt))) errors.endAt = '结束时刻格式要像 2026-09-01 12:00:00，留空表示占用中';
  if (merged.endAt && String(merged.endAt) <= String(merged.startAt)) errors.endAt = '结束时刻要晚于开始时刻';
  if (merged.source && !OCCUPANCY_SOURCE.includes(merged.source)) errors.source = '来源只能是 auto 或 manual';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '设备占用账没通过校验', errors);
}

function listOccupancies(data, query) {
  const q = query || {};
  let rows = data.occupancies.slice();
  if (q.batchId) rows = rows.filter((o) => o.batchId === q.batchId);
  if (q.roomId) rows = rows.filter((o) => o.roomId === q.roomId);
  if (q.probeId) rows = rows.filter((o) => o.probeId === q.probeId);
  return rows.map((o) => coldlib.decorateOccupancy(data, o)).sort((a, b) => (a.startAt < b.startAt ? -1 : 1));
}

function createOccupancy(data, payload) {
  validateOccupancy(data, payload, null);
  const row = {
    id: store.nextId('oc', data.occupancies),
    batchId: payload.batchId,
    roomId: payload.roomId,
    probeId: payload.probeId ? String(payload.probeId) : '',
    startAt: String(payload.startAt),
    endAt: payload.endAt ? String(payload.endAt) : '',
    source: 'manual',
    remark: String(payload.remark || ''),
  };
  data.occupancies.push(row);
  coldlib.invalidateAttribution(data);
  return coldlib.decorateOccupancy(data, row);
}

function updateOccupancy(data, id, payload) {
  const row = data.occupancies.find((o) => o.id === id);
  if (!row) throw new AppError(404, 'OCCUPANCY_NOT_FOUND', '这条设备占用不存在');
  validateOccupancy(data, payload, row);
  const merged = Object.assign({}, row, payload);
  Object.assign(row, {
    batchId: merged.batchId,
    roomId: merged.roomId,
    probeId: merged.probeId ? String(merged.probeId) : '',
    startAt: String(merged.startAt),
    endAt: merged.endAt ? String(merged.endAt) : '',
    remark: String(merged.remark || ''),
  });
  coldlib.invalidateAttribution(data);
  return coldlib.decorateOccupancy(data, row);
}

function removeOccupancy(data, id) {
  const row = data.occupancies.find((o) => o.id === id);
  if (!row) throw new AppError(404, 'OCCUPANCY_NOT_FOUND', '这条设备占用不存在');
  data.occupancies = data.occupancies.filter((o) => o.id !== id);
  coldlib.invalidateAttribution(data);
  return { removed: id };
}

// 把一条占用在指定时刻拆成两段（第二段改挂给 toBatchId，用于手工处理重叠交接）
function splitOccupancy(data, id, payload) {
  const row = data.occupancies.find((o) => o.id === id);
  if (!row) throw new AppError(404, 'OCCUPANCY_NOT_FOUND', '这条设备占用不存在');
  const at = String((payload || {}).at || '');
  const errors = {};
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(at)) errors.at = '拆分时刻格式要像 2026-09-01 12:00:00';
  if (at && (at <= row.startAt || (row.endAt && at >= row.endAt))) errors.at = '拆分时刻必须落在占用时段内部';
  const toBatchId = (payload || {}).toBatchId;
  if (toBatchId && !data.batches.some((b) => b.id === toBatchId)) errors.toBatchId = '后半段要交给的批次不存在';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '占用拆分没通过校验', errors);
  row.endAt = at;
  const next = {
    id: store.nextId('oc', data.occupancies),
    batchId: toBatchId || row.batchId,
    roomId: row.roomId,
    probeId: row.probeId,
    startAt: at,
    endAt: '',
    source: 'manual',
    remark: toBatchId ? '拆分并交给后占用批次' : '由占用账拆分生成',
  };
  data.occupancies.push(next);
  coldlib.invalidateAttribution(data);
  return { at, first: coldlib.decorateOccupancy(data, row), second: coldlib.decorateOccupancy(data, next) };
}

function listRecords(data, query) {
  const q = query || {};
  let rows = data.records.slice();
  if (q.batchId) rows = rows.filter((r) => r.batchId === q.batchId);
  if (q.probeId) rows = rows.filter((r) => r.probeId === q.probeId);
  if (q.source) rows = rows.filter((r) => r.source === q.source);
  if (q.attribution) rows = rows.filter((r) => coldlib.attributionMap(data)[r.id] && coldlib.attributionMap(data)[r.id].status === q.attribution);
  if (q.from) rows = rows.filter((r) => r.at >= q.from);
  if (q.to) rows = rows.filter((r) => r.at <= q.to);
  const amap = coldlib.attributionMap(data);
  return rows
    .map((r) => {
      const a = amap[r.id] || {};
      return Object.assign({}, r, {
        batchCode: batchCode(data, r.batchId),
        probeCode: probeCode(data, r.probeId),
        outOfRange: Number(r.temperatureC) > Number(data.settings.upperLimitC) || Number(r.temperatureC) < Number(data.settings.lowerLimitC),
        attributionStatus: a.status || '',
        attributionReason: a.reason || '',
        resolvedBatchId: a.resolvedBatchId || null,
        resolvedBatchCode: a.resolvedBatchId ? batchCode(data, a.resolvedBatchId) : '',
      });
    })
    .sort((a, b) => (a.at < b.at ? 1 : -1));
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
  coldlib.invalidateAttribution(data);
  return decorateRecord(data, record);
}

function decorateRecord(data, record) {
  const a = coldlib.attributionMap(data)[record.id] || {};
  return Object.assign({}, record, {
    batchCode: batchCode(data, record.batchId),
    probeCode: probeCode(data, record.probeId),
    outOfRange: Number(record.temperatureC) > Number(data.settings.upperLimitC) || Number(record.temperatureC) < Number(data.settings.lowerLimitC),
    attributionStatus: a.status || '',
    attributionReason: a.reason || '',
    resolvedBatchId: a.resolvedBatchId || null,
    resolvedBatchCode: a.resolvedBatchId ? batchCode(data, a.resolvedBatchId) : '',
  });
}

// 改挂：只允许改批次（处理账外归他/存疑记录）与备注，温度、时刻、探头不可改
function updateRecord(data, id, payload) {
  const record = data.records.find((r) => r.id === id);
  if (!record) throw new AppError(404, 'RECORD_NOT_FOUND', '这条温度记录不存在');
  const patch = payload || {};
  const errors = {};
  if (patch.batchId !== undefined) {
    if (!data.batches.some((b) => b.id === patch.batchId)) errors.batchId = '改挂的批次不存在';
  }
  if (patch.remark !== undefined && typeof patch.remark !== 'string') errors.remark = '备注要是文字';
  ['probeId', 'at', 'temperatureC', 'source', 'operator'].forEach((k) => {
    if (patch[k] !== undefined) errors[k] = '这个字段不能改；改挂只能改批次';
  });
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '温度记录的修改没通过校验', errors);
  if (patch.batchId !== undefined) record.batchId = patch.batchId;
  if (patch.remark !== undefined) record.remark = String(patch.remark);
  coldlib.invalidateAttribution(data);
  return decorateRecord(data, record);
}

function removeRecord(data, id) {
  const record = data.records.find((r) => r.id === id);
  if (!record) throw new AppError(404, 'RECORD_NOT_FOUND', '这条温度记录不存在');
  data.records = data.records.filter((r) => r.id !== id);
  coldlib.invalidateAttribution(data);
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
    basis: String(payload.basis || '').trim(),
    remark: String(payload.remark || ''),
  };
  data.releases.push(release);
  batch.status = payload.decision === '放行' ? '已放行' : '已拒收';
  batch.decidedAt = release.decidedAt;
  closeOpenOccupancies(data, batch.id, release.decidedAt);
  coldlib.invalidateAttribution(data);
  return { release, batch: decorateBatch(data, batch) };
}

module.exports = {
  listRooms, roomDetail, createRoom, updateRoom, removeRoom,
  listProbes, createProbe, updateProbe, removeProbe,
  listBatches, batchDetail, createBatch, updateBatch, removeBatch,
  listRecords, createRecord, updateRecord, removeRecord,
  listOccupancies, createOccupancy, updateOccupancy, removeOccupancy, splitOccupancy,
  listReleases, decide,
  ROOM_STATUS, ROOM_TYPE, PROBE_STATUS, BATCH_STATUS, SOURCE_LIST,
};
