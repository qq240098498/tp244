// 归属与隔离：把温度记录落到「批次 + 设备 + 探头 + 时段」上。
// 设备占用窗 occupancies 是账：哪个批次在哪段时间占着哪个设备上的哪台探头。
// 记录先按占用窗命中，再按交叠/边界口径裁决，人工改判优先级最高。
const store = require('./store');

const STATUS = {
  CONFIRMED: 'confirmed',          // 唯一占用窗，批次/设备/探头都对得上，计入判定
  BOUNDARY: 'boundary',            // 两窗首尾相接的交接点，按边界口径切分，计入判定
  DISPUTED: 'disputed',            // 同一时刻多条占用窗交叠，拆不开，存疑不计入
  OUT_OF_WINDOW: 'out-of-window',  // 该时刻这台探头没有任何批次占用，不计入
  DEVICE_MISMATCH: 'device-mismatch', // 探头台账所属设备与占用账设备对不上，不计入
  WRONG_BATCH: 'wrong-batch',      // 唯一占用窗属于别的批次，记录挂错批次，不计入
  MANUAL_ASSIGNED: 'manual-assigned', // 人工改判计入某条占用窗
  MANUAL_EXCLUDED: 'manual-excluded', // 人工剔除
};

const STATUS_TEXT = {
  'confirmed': '归属明确',
  'boundary': '边界切分',
  'disputed': '交叠存疑',
  'out-of-window': '占用窗外',
  'device-mismatch': '设备对不上',
  'wrong-batch': '挂错批次',
  'manual-assigned': '人工计入',
  'manual-excluded': '人工剔除',
};

const COUNTED_STATUS = {
  'confirmed': true,
  'boundary': true,
  'manual-assigned': true,
};

const OVERLAP_POLICY_TEXT = {
  window: '按占用窗逐点切：记录时刻只落进一条占用窗就归该批；落进交叠内核的拆不开，一律存疑、不计入任何一边',
  first: '先占先得：交叠时刻判给占用开始更早的批次（开始时刻相同按占用窗登记先后）',
  manual: '交叠全部人工裁定：交叠内核的记录一律先存疑，等值班员逐条改判',
};

const BOUNDARY_POLICY_TEXT = {
  front: '交接点算前一批：占用窗按 [起, 止] 计，首尾相接时交接那一时刻的读数归随车走完的前一批',
  back: '交接点算后一批：占用窗按 [起, 止) 计，首尾相接时交接那一时刻的读数归接手的后一批',
};

function buildIndex(data) {
  const windowsByProbe = new Map();
  const windowsById = new Map();
  for (const w of data.occupancies) {
    windowsById.set(w.id, w);
    let list = windowsByProbe.get(w.probeId);
    if (!list) {
      list = [];
      windowsByProbe.set(w.probeId, list);
    }
    list.push(w);
  }
  for (const list of windowsByProbe.values()) {
    list.sort((a, b) => (a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : (a.id < b.id ? -1 : 1)));
  }
  // 只保留生效中的改判（未撤销、未被新改判替代），每条记录至多一条
  const overridesByRecord = new Map();
  for (const o of data.attributionOverrides) {
    if (o.revokedAt || o.supersededAt) continue;
    overridesByRecord.set(o.recordId, o);
  }
  return { windowsByProbe, windowsById, overridesByRecord };
}

// 时刻 at 落在哪些占用窗上。边界口径在这一步处理：
// 两窗首尾相接、at 正好是交接点时，front 留给结束的前一批，back 让给开始的后一批。
function activeWindowsAt(windows, at, boundaryPolicy) {
  const hits = windows.filter((w) => w.startAt <= at && (w.endAt === '' || w.endAt >= at));
  if (hits.length <= 1) return { hits, boundary: false };
  const ending = hits.filter((w) => w.endAt !== '' && w.endAt === at && w.startAt !== at);
  const starting = hits.filter((w) => w.startAt === at && (w.endAt === '' || w.endAt !== at));
  if (!ending.length || !starting.length) return { hits, boundary: false };
  const boundary = true;
  if (boundaryPolicy === 'back') {
    return { hits: hits.filter((w) => !(w.endAt !== '' && w.endAt === at && w.startAt !== at)), boundary };
  }
  return { hits: hits.filter((w) => !(w.startAt === at && (w.endAt === '' || w.endAt !== at))), boundary };
}

function pickEarliest(windows) {
  return windows.slice().sort((a, b) => (
    a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : (a.id < b.id ? -1 : 1)
  ))[0];
}

// 单条记录的归属裁决。index 由 buildIndex 给出（一次请求只建一次）。
function attributeRecord(data, record, index) {
  index = index || buildIndex(data);
  const settings = data.settings || {};
  const overlapPolicy = settings.overlapPolicy || 'window';
  const boundaryPolicy = settings.boundaryPolicy || 'front';
  const relatedBatchIds = [record.batchId];
  const relate = (id) => { if (id && relatedBatchIds.indexOf(id) < 0) relatedBatchIds.push(id); };

  const base = {
    recordId: record.id,
    status: STATUS.OUT_OF_WINDOW,
    counted: false,
    occupancyId: null,
    chargedBatchId: null,
    boundary: false,
    basis: '',
    hitOccupancyIds: [],
    relatedBatchIds,
  };

  // 1) 人工改判优先级最高
  const override = index.overridesByRecord.get(record.id);
  if (override) {
    if (override.kind === 'exclude') {
      return Object.assign(base, { status: STATUS.MANUAL_EXCLUDED, basis: '人工剔除：' + (override.reason || '') });
    }
    const w = index.windowsById.get(override.occupancyId);
    if (w) {
      relate(w.batchId);
      return Object.assign(base, {
        status: STATUS.MANUAL_ASSIGNED,
        counted: true,
        occupancyId: w.id,
        chargedBatchId: w.batchId,
        basis: '人工计入 ' + w.batchId + '：' + (override.reason || ''),
      });
    }
  }

  // 2) 按探头占用窗命中（无 probeId 的占用窗不挂探头，不参与记录归属）
  const windows = index.windowsByProbe.get(record.probeId) || [];
  const { hits, boundary } = activeWindowsAt(windows, record.at, boundaryPolicy);
  hits.forEach((w) => relate(w.batchId));
  base.hitOccupancyIds = hits.map((w) => w.id);
  base.boundary = boundary;
  if (!hits.length) {
    return Object.assign(base, {
      status: STATUS.OUT_OF_WINDOW,
      basis: '该时刻探头 ' + record.probeId + ' 没有任何批次占用',
    });
  }

  // 3) 多条窗命中：先按探头当前设备分一遍——只在设备对得上的窗之间裁决
  const probe = data.probes.find((p) => p.id === record.probeId);
  let good = hits;
  const bad = [];
  if (probe) {
    good = [];
    for (const w of hits) {
      if (w.roomId === probe.roomId) good.push(w);
      else bad.push(w.id);
    }
  }
  if (!good.length) {
    return Object.assign(base, {
      status: STATUS.DEVICE_MISMATCH,
      occupancyId: hits[0].id,
      basis: '探头台账在 ' + (probe ? probe.roomId : '?') + '，占用账在 ' + hits.map((w) => w.roomId).join('/') + '（探头被挪过或批次改过库位/车厢）',
    });
  }

  // 4) 设备对得上的窗唯一：边界点或归属明确
  let chosen = null;
  let fromOverlap = false;
  if (good.length === 1) {
    chosen = good[0];
    if (boundary) base.basis = boundaryPolicy === 'front' ? '交接点按口径算前一批' : '交接点按口径算后一批';
  } else if (overlapPolicy === 'first') {
    // 5) 交叠内核 + 先占先得：判给开始更早的占用
    chosen = pickEarliest(good);
    fromOverlap = true;
    base.basis = '交叠时段按先占先得判给开始更早的占用';
  } else {
    return Object.assign(base, {
      status: STATUS.DISPUTED,
      basis: overlapPolicy === 'manual'
        ? '交叠时段按口径全部待人工裁定'
        : '同一时刻被多条占用窗覆盖，数据不足以判定归属',
    });
  }

  // 6) 批次对不对得上。交接边界点按口径切到接手批次时，记录即使挂在前批名下也算边界切分；
  //    其余占用方明确的情况数据物理上属于占用批次：计入占用方，挂在别的批次名下的标 wrong-batch。
  if (chosen.batchId === record.batchId || boundary) {
    return Object.assign(base, {
      status: boundary ? STATUS.BOUNDARY : STATUS.CONFIRMED,
      counted: true,
      occupancyId: chosen.id,
      chargedBatchId: chosen.batchId,
    });
  }
  return Object.assign(base, {
    status: STATUS.WRONG_BATCH,
    counted: true,
    occupancyId: chosen.id,
    chargedBatchId: chosen.batchId,
    basis: '该时刻占用探头的是批次 ' + chosen.batchId + '，记录却挂在 ' + record.batchId +
      (fromOverlap ? '（交叠按先占先得计入占用方）' : ''),
  });
}

// 全量记录归属表：recordId → 裁决结果
function attributionMap(data) {
  const index = buildIndex(data);
  const map = new Map();
  for (const r of data.records) map.set(r.id, attributeRecord(data, r, index));
  return map;
}

// 一次请求内 data 是整文件重新加载的，归属表可挂在 data 上复用；
// 占用窗/改判/记录发生增删改后由调用方 invalidate(data) 作废。
// 用不可枚举属性，避免 JSON.stringify 把 Map 写进 db.json。
function mapFor(data) {
  if (!data.__attrMap) {
    Object.defineProperty(data, '__attrMap', { value: attributionMap(data), enumerable: false, writable: true, configurable: true });
  }
  return data.__attrMap;
}

function invalidate(data) {
  if ('__attrMap' in data) data.__attrMap = null;
}

// 计入某批次判定的记录（chargedBatchId 落在本批），保持时刻升序
function recordsChargedTo(data, batchId) {
  const map = mapFor(data);
  const out = [];
  for (const r of data.records) {
    const a = map.get(r.id);
    if (a.counted && a.chargedBatchId === batchId) out.push(r);
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

// 与某批次相关但不能正常计入本批判定的问题记录：
// 1) 挂在本批但被剔除/存疑/窗外/设备对不上，或计入了别的占用批次（wrong-batch）；
// 2) 交叠存疑点：即使读数挂在别的批次名下，只要交叠占用窗含本批，本批也要被挡住。
function problemRecords(data, batchId) {
  const map = mapFor(data);
  const out = [];
  for (const r of data.records) {
    const a = map.get(r.id);
    const hungHere = r.batchId === batchId;
    const disputedHere = a.status === STATUS.DISPUTED && a.relatedBatchIds.indexOf(batchId) >= 0;
    const chargedElsewhere = a.counted && a.chargedBatchId !== batchId;
    if ((hungHere && (!a.counted || chargedElsewhere)) || (!hungHere && disputedHere)) {
      out.push({ record: r, attribution: a });
    }
  }
  out.sort((x, y) => (x.record.at < y.record.at ? -1 : x.record.at > y.record.at ? 1 : 0));
  return out;
}

function problemCounts(data, batchId) {
  const counts = { total: 0 };
  for (const item of problemRecords(data, batchId)) {
    counts.total += 1;
    counts[item.attribution.status] = (counts[item.attribution.status] || 0) + 1;
  }
  return counts;
}

// 占用窗之间的重叠（同一探头，时段内部严格相交；首尾相接不算重叠，交接点走边界口径）
function effectiveEnd(w, horizon) {
  return w.endAt === '' ? horizon : w.endAt;
}

function overlapsOf(windows, horizon) {
  const result = {};
  for (const w of windows) {
    const list = [];
    const we = effectiveEnd(w, horizon);
    for (const other of windows) {
      if (other.id === w.id) continue;
      const oe = effectiveEnd(other, horizon);
      if (w.startAt < oe && other.startAt < we) {
        list.push({ occupancyId: other.id, batchId: other.batchId, from: w.startAt < other.startAt ? other.startAt : w.startAt, to: we < oe ? we : oe });
      }
    }
    result[w.id] = list;
  }
  return result;
}

// 单条时间线（同一台探头的占用窗）：切出独占、交叠、空档时间片，并把记录归到片上。
function laneFor(data, probeId, windowsIn, attrMap) {
  const windows = windowsIn.slice().sort((a, b) => (a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : (a.id < b.id ? -1 : 1)));
  const now = store.nowText();
  let horizon = now;
  for (const w of windows) {
    if (w.endAt === '') continue;
    if (w.endAt > horizon) horizon = w.endAt;
  }
  if (probeId) {
    for (const r of data.records) {
      if (r.probeId === probeId && r.at > horizon) horizon = r.at;
    }
  }

  const events = new Set();
  for (const w of windows) {
    events.add(w.startAt);
    events.add(w.endAt === '' ? horizon : w.endAt);
  }
  const times = Array.from(events).sort();

  const slices = [];
  for (let i = 0; i < times.length - 1; i += 1) {
    const left = times[i];
    const right = times[i + 1];
    const active = windows.filter((w) => w.startAt <= left && (w.endAt === '' ? horizon >= right : w.endAt >= right));
    const batchIds = [];
    for (const w of active) if (batchIds.indexOf(w.batchId) < 0) batchIds.push(w.batchId);
    slices.push({
      startAt: left,
      endAt: right,
      kind: active.length === 0 ? 'gap' : (active.length > 1 ? 'overlap' : 'sole'),
      occupancies: active.map((w, idx) => ({
        id: w.id, batchId: w.batchId, roomId: w.roomId, probeId: w.probeId,
        purpose: w.purpose, open: w.endAt === '', order: windows.indexOf(w) + 1,
      })),
      batchIds,
      recordCount: 0,
      countedRecordCount: 0,
      disputedRecordCount: 0,
      recordsByStatus: {},
    });
  }

  const winById = new Map(windows.map((w) => [w.id, w]));
  const putRecord = (item, idx) => {
    const slice = slices[idx];
    if (!slice) return;
    slice.recordCount += 1;
    const st = item.attribution.status;
    slice.recordsByStatus[st] = (slice.recordsByStatus[st] || 0) + 1;
    if (item.attribution.counted) slice.countedRecordCount += 1;
    if (!item.attribution.counted) slice.disputedRecordCount += 1;
  };
  if (probeId) {
    for (const r of data.records) {
      if (r.probeId !== probeId) continue;
      const a = attrMap.get(r.id);
      const item = { record: r, attribution: a };
      let placed = false;
      const win = a.occupancyId ? winById.get(a.occupancyId) : null;
      if (win) {
        for (let i = 0; i < slices.length; i += 1) {
          const s = slices[i];
          if (!s.occupancies.some((o) => o.id === win.id)) continue;
          if (r.at >= s.startAt && r.at < s.endAt) { putRecord(item, i); placed = true; break; }
          // 边界点（前批口径）：at 正好是该片右端、占用窗在这一点结束
          if (r.at === s.endAt && win.endAt !== '' && win.endAt === r.at && win.startAt !== r.at) { putRecord(item, i); placed = true; break; }
        }
      }
      // 交叠窗在右端点结束、该点仍被多方占用的存疑读数，归左侧交叠片而不是后面的独占片
      if (!placed) {
        for (let i = 0; i < slices.length; i += 1) {
          const s = slices[i];
          if (r.at === s.endAt && s.kind === 'overlap' &&
            s.occupancies.some(function (o) { return (a.hitOccupancyIds || []).indexOf(o.id) >= 0; })) {
            putRecord(item, i); placed = true; break;
          }
        }
      }
      if (!placed) {
        for (let i = 0; i < slices.length; i += 1) {
          if (r.at >= slices[i].startAt && r.at < slices[i].endAt) { putRecord(item, i); placed = true; break; }
        }
      }
    }
  }

  const overlapMap = overlapsOf(windows, horizon);
  return {
    probeId,
    horizon,
    windows: windows.map((w, i) => Object.assign({}, w, { order: i + 1, open: w.endAt === '', overlaps: overlapMap[w.id] || [] })),
    slices: slices.filter((s) => s.kind !== 'gap' || s.recordCount > 0),
  };
}

// 时间线切片账：按设备筛选占用窗，再按探头分成一条条时间线。
function timeline(data, query) {
  const q = query || {};
  let windows = data.occupancies.slice();
  if (q.roomId) windows = windows.filter((w) => w.roomId === q.roomId);
  if (q.probeId) windows = windows.filter((w) => w.probeId === q.probeId);

  const byProbe = new Map();
  for (const w of windows) {
    if (!byProbe.has(w.probeId)) byProbe.set(w.probeId, []);
    byProbe.get(w.probeId).push(w);
  }
  const attrMap = attributionMap(data);
  const lanes = [];
  for (const [probeId, list] of byProbe.entries()) {
    const lane = laneFor(data, probeId, list, attrMap);
    const roomIds = [];
    for (const w of list) if (roomIds.indexOf(w.roomId) < 0) roomIds.push(w.roomId);
    lane.roomIds = roomIds;
    lane.windowCount = list.length;
    lane.overlapSliceCount = lane.slices.filter((s) => s.kind === 'overlap').length;
    lane.disputedRecordCount = lane.slices.reduce((acc, s) => acc + s.disputedRecordCount, 0);
    lanes.push(lane);
  }
  lanes.sort((a, b) => (a.probeId < b.probeId ? -1 : a.probeId > b.probeId ? 1 : 0));
  return { roomId: q.roomId || '', probeId: q.probeId || '', lanes };
}

module.exports = {
  STATUS,
  STATUS_TEXT,
  COUNTED_STATUS,
  OVERLAP_POLICY_TEXT,
  BOUNDARY_POLICY_TEXT,
  buildIndex,
  activeWindowsAt,
  attributeRecord,
  attributionMap,
  mapFor,
  invalidate,
  recordsChargedTo,
  problemRecords,
  problemCounts,
  timeline,
};
