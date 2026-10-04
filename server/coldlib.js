// 温控口径都集中在这里：设备占用账、记录归属、重叠裁决、超限段、断链、MKT、放行判定
const store = require('./store');

function toDate(text) {
  return new Date(String(text).replace(' ', 'T') + '+08:00');
}

function toMs(text) {
  return toDate(text).getTime();
}

const OPEN_END = Infinity;

function recordsOfBatch(data, batchId) {
  return data.records
    .filter((r) => r.batchId === batchId)
    .slice()
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function probeOf(data, probeId) {
  return data.probes.find((p) => p.id === probeId) || null;
}

function batchOf(data, batchId) {
  return data.batches.find((b) => b.id === batchId) || null;
}

function endMs(row) {
  return row.endAt ? toMs(row.endAt) : OPEN_END;
}

// 判定引擎只认探头占用行（probeId 非空）；probeId 为空的设备行只用于账本展示
function probeOccupancies(data, probeId) {
  return data.occupancies
    .filter((o) => o.probeId === probeId)
    .slice()
    .sort((a, b) => (a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : a.id < b.id ? -1 : 1));
}

function lastProbeRecordMs(data, probeId) {
  let last = -Infinity;
  for (const r of data.records) {
    if (r.probeId === probeId) {
      const t = toMs(r.at);
      if (t > last) last = t;
    }
  }
  return last === -Infinity ? null : last;
}

// 覆盖按闭区间 [start, end] 收集；首尾相接（end==start）的零长交接不算重叠窗，只在边界规则里决定归属
function coveringRows(rows, t) {
  return rows.filter((o) => toMs(o.startAt) <= t && t <= endMs(o));
}

// 同一批次在同一探头上可能拆成多行，窗口成员按批次去重，保留最早开始的那行
function dedupeBatchRows(rows) {
  const picked = {};
  for (const row of rows) {
    const cur = picked[row.batchId];
    if (!cur || toMs(row.startAt) < toMs(cur.startAt)) picked[row.batchId] = row;
  }
  return Object.keys(picked).map((k) => picked[k]);
}

// 裁决排序：占用开始 / 批次入库 / 该探头最早记录；并列按批次 id
function orderBatches(data, probeId, rows, basis) {
  const firstRecordMs = {};
  if (basis === 'recordFirst') {
    for (const r of data.records) {
      if (r.probeId !== probeId) continue;
      const t = toMs(r.at);
      if (firstRecordMs[r.batchId] === undefined || t < firstRecordMs[r.batchId]) firstRecordMs[r.batchId] = t;
    }
  }
  return rows.slice().sort((a, b) => {
    let ka;
    let kb;
    if (basis === 'loadedAt') {
      const ba = batchOf(data, a.batchId);
      const bb = batchOf(data, b.batchId);
      ka = ba ? toMs(ba.loadedAt) : 0;
      kb = bb ? toMs(bb.loadedAt) : 0;
    } else if (basis === 'recordFirst') {
      ka = firstRecordMs[a.batchId] === undefined ? Infinity : firstRecordMs[a.batchId];
      kb = firstRecordMs[b.batchId] === undefined ? Infinity : firstRecordMs[b.batchId];
    } else {
      ka = toMs(a.startAt);
      kb = toMs(b.startAt);
    }
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.batchId < b.batchId ? -1 : 1;
  });
}

// 枚举一个探头上所有真正的重叠窗（开始 < 结束），开口行用该探头最后一条记录时刻收口
function overlapWindows(data, probeId, rows) {
  const starts = rows.map((o) => toMs(o.startAt)).sort((a, b) => a - b);
  const windows = [];
  for (let i = 0; i < starts.length; i += 1) {
    const ws = starts[i];
    const open = rows.filter((o) => toMs(o.startAt) <= ws && ws <= endMs(o));
    if (open.length < 2) continue;
    let we = Math.min.apply(null, open.map((o) => endMs(o)));
    if (we === OPEN_END) we = lastProbeRecordMs(data, probeId);
    if (we === null || we <= ws) continue;
    if (windows.length && ws <= windows[windows.length - 1].startMs && we <= windows[windows.length - 1].endMs) continue;
    windows.push({ startMs: ws, endMs: we, rows: dedupeBatchRows(open) });
  }
  // 去重（同一边界组合可能被多个 start 触发）
  const uniq = [];
  for (const w of windows) {
    const key = w.startMs + '|' + w.endMs + '|' + w.rows.map((r) => r.batchId).sort().join(',');
    if (!uniq.some((u) => u.key === key)) uniq.push(Object.assign({}, w, { key }));
  }
  return uniq;
}

// 中点均分：返回排序后各批次在窗内分得的子时段（毫秒）
function midpointSlices(w, ordered) {
  const n = ordered.length;
  const step = (w.endMs - w.startMs) / n;
  return ordered.map((row, i) => ({
    batchId: row.batchId,
    startMs: w.startMs + step * i,
    endMs: w.startMs + step * (i + 1),
  }));
}

function sliceOwnerAt(slices, t, boundary) {
  for (let i = 0; i < slices.length; i += 1) {
    const s = slices[i];
    const last = i === slices.length - 1;
    if (boundary === 'rightClosed') {
      // 左开右闭：切片内部 (起,止] 归本批；只有第一段的起点（窗起点，没有前者）归第一段
      if (i === 0 && t === s.startMs) return s.batchId;
      if (t > s.startMs && t <= s.endMs) return s.batchId;
    } else {
      // 左闭右开：[起,止) 归本批；只有最后一段的终点（窗终点，没有后者）归末段
      if (t >= s.startMs && (t < s.endMs || (last && t === s.endMs))) return s.batchId;
    }
  }
  return null;
}

function settingsOf(data) {
  return data.settings || {};
}

/* ---------- 单条记录归属 ---------- */

// 返回 {status, resolvedBatchId, reason, watchers:[batchId], window?}
// status：明确 / 重叠裁得 / 账外归他 / 存疑
function resolveRecord(data, record, instantGroupsArg) {
  const settings = settingsOf(data);
  const instantGroups = instantGroupsArg || instantGroupsOf(data);

  // 同一探头同一时刻挂了多个不同批次的记录：一个探头同一时刻只有一个读数，
  // 多挂就是数据本身拆不开，不管自动还是手工都判存疑；同批次同刻的手工更正在
  // effectiveRecords 的手工优先去重里处理，不算冲突。
  const sameInstant = instantGroups ? instantGroups[record.probeId + '|' + record.at] : null;
  if (sameInstant && sameInstant.length > 1) {
    const tagBatches = {};
    sameInstant.forEach((r) => { tagBatches[r.batchId] = true; });
    if (Object.keys(tagBatches).length > 1) {
      return {
        status: '存疑', resolvedBatchId: null, reason: 'same-instant-conflict',
        watchers: Object.keys(tagBatches),
        conflicts: Object.keys(tagBatches),
      };
    }
  }

  const rows = probeOccupancies(data, record.probeId);
  const t = toMs(record.at);
  const candidates = dedupeBatchRows(coveringRows(rows, t));

  if (candidates.length === 0) {
    // 设备级兜底：没有探头占用行时，看探头当前所属设备上是否只有一个批次占着
    const probe = probeOf(data, record.probeId);
    if (probe) {
      const deviceRows = data.occupancies.filter(
        (o) => !o.probeId && o.roomId === probe.roomId && toMs(o.startAt) <= t && t <= endMs(o)
      );
      const deviceBatches = dedupeBatchRows(deviceRows);
      if (deviceBatches.length === 1) {
        const owner = deviceBatches[0].batchId;
        if (owner === record.batchId) {
          return { status: '明确', resolvedBatchId: owner, reason: 'device-level', watchers: [], conflicts: [] };
        }
        return { status: '账外归他', resolvedBatchId: owner, reason: 'mis-tagged-device', watchers: [record.batchId], conflicts: [owner] };
      }
      if (deviceBatches.length >= 2) {
        return {
          status: '存疑', resolvedBatchId: null, reason: 'device-ambiguous',
          watchers: deviceBatches.map((r) => r.batchId),
          conflicts: deviceBatches.map((r) => r.batchId),
        };
      }
    }
    return { status: '存疑', resolvedBatchId: null, reason: 'no-occupancy', watchers: [record.batchId], conflicts: [] };
  }

  // 多个占用行首尾相接在同一时刻（零长交接）：不算重叠，按边界规则在两者间裁决
  let windowRows = candidates;
  let window = null;
  if (candidates.length >= 2) {
    const realWindows = overlapWindows(data, record.probeId, rows);
    window = realWindows.find((w) => t > w.startMs && t < w.endMs) ||
      realWindows.find((w) => t >= w.startMs && t <= w.endMs) || null;
    windowRows = window ? window.rows : candidates;
  }

  if (windowRows.length === 1 || !window) {
    // 唯一占用方；零长交接时刻按边界规则在候选里取先/后
    let owner = windowRows[0].batchId;
    if (candidates.length >= 2) {
      const ordered = orderBatches(data, record.probeId, candidates, settings.overlapTieBasis);
      owner = settings.boundaryPolicy === 'rightClosed' ? ordered[ordered.length - 1].batchId : ordered[0].batchId;
    }
    if (owner === record.batchId) {
      return { status: '明确', resolvedBatchId: owner, reason: 'sole-occupant', watchers: [], conflicts: candidates.length > 1 ? candidates.map((r) => r.batchId) : [] };
    }
    return { status: '账外归他', resolvedBatchId: owner, reason: 'mis-tagged', watchers: [record.batchId], conflicts: candidates.map((r) => r.batchId) };
  }

  // 真重叠窗
  const ordered = orderBatches(data, record.probeId, window.rows, settings.overlapTieBasis);
  if (settings.overlapPolicy === 'suspend') {
    return {
      status: '存疑', resolvedBatchId: null, reason: 'overlap-suspended',
      watchers: ordered.map((r) => r.batchId),
      conflicts: ordered.map((r) => r.batchId),
      window: { startMs: window.startMs, endMs: window.endMs },
    };
  }
  let owner;
  if (settings.overlapPolicy === 'firstWins') {
    owner = ordered[0].batchId;
  } else {
    owner = sliceOwnerAt(midpointSlices(window, ordered), t, settings.boundaryPolicy);
  }
  if (!owner) {
    return { status: '存疑', resolvedBatchId: null, reason: 'overlap-undecidable', watchers: ordered.map((r) => r.batchId), conflicts: ordered.map((r) => r.batchId) };
  }
  return {
    status: owner === record.batchId ? '重叠裁得' : '账外归他',
    resolvedBatchId: owner,
    reason: owner === record.batchId ? 'overlap-awarded' : 'overlap-awarded-other',
    watchers: owner === record.batchId ? [] : [record.batchId],
    conflicts: ordered.map((r) => r.batchId),
    window: { startMs: window.startMs, endMs: window.endMs, order: ordered.map((r) => r.batchId) },
  };
}

// 全部记录的归属解析（同一请求内缓存；记录/占用/口径有改动时由 invalidateAttribution 清掉）
function invalidateAttribution(data) {
  delete data.__attrCache;
  delete data.__instantGroups;
}

function instantGroupsOf(data) {
  if (!data.__instantGroups) {
    const groups = {};
    for (const r of data.records) {
      const key = r.probeId + '|' + r.at;
      (groups[key] = groups[key] || []).push(r);
    }
    data.__instantGroups = groups;
  }
  return data.__instantGroups;
}

function attributionMap(data) {
  if (data.__attrCache) return data.__attrCache.value;
  const instantGroups = instantGroupsOf(data);
  const value = {};
  for (const r of data.records) value[r.id] = resolveRecord(data, r, instantGroups);
  data.__attrCache = { value };
  return value;
}

// 同一探头同一时刻既有自动记录又有手工更正时，以手工为准（在归属后的记录流内去重）
function manualPriorityDedupe(rows) {
  const picked = {};
  const order = [];
  for (const row of rows) {
    const key = row.probeId + '|' + row.at;
    if (picked[key] === undefined) {
      picked[key] = row;
      order.push(key);
      continue;
    }
    if (picked[key].source !== '人工' && row.source === '人工') picked[key] = row;
  }
  return order.map((key) => picked[key]);
}

// 归属后、参与某批次判定的有效记录流
function effectiveRecords(data, batchId) {
  const amap = attributionMap(data);
  const rows = data.records
    .filter((r) => amap[r.id] && amap[r.id].resolvedBatchId === batchId)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return manualPriorityDedupe(rows);
}

/* ---------- 批次视角的归属汇总 ---------- */

function batchAttribution(data, batchId) {
  const amap = attributionMap(data);
  const tagged = [];
  const claimedIn = [];
  const unresolved = [];
  for (const r of data.records) {
    const a = amap[r.id];
    const taggedHere = r.batchId === batchId;
    const awardedHere = a.resolvedBatchId === batchId;
    if (taggedHere) {
      tagged.push(Object.assign({}, r, { attribution: a }));
    }
    if (!taggedHere && awardedHere) claimedIn.push(Object.assign({}, r, { attribution: a }));
    if (a.status === '存疑' && a.watchers.indexOf(batchId) !== -1) {
      unresolved.push(Object.assign({}, r, { attribution: a }));
    }
  }
  const misTagged = tagged.filter((r) => r.attribution.resolvedBatchId && r.attribution.resolvedBatchId !== batchId);
  const occupiedProbeRows = data.occupancies.filter((o) => o.batchId === batchId && o.probeId);
  const overlaps = [];
  const probeIds = {};
  occupiedProbeRows.forEach((o) => { probeIds[o.probeId] = true; });
  Object.keys(probeIds).forEach((probeId) => {
    const rows = probeOccupancies(data, probeId);
    for (const w of overlapWindows(data, probeId, rows)) {
      if (w.rows.every((r) => r.batchId !== batchId)) continue;
      const settings = settingsOf(data);
      const ordered = orderBatches(data, probeId, w.rows, settings.overlapTieBasis);
      const slices = settings.overlapPolicy === 'midpoint' ? midpointSlices(w, ordered) : null;
      overlaps.push({
        probeId,
        startAt: msToText(w.startMs),
        endAt: msToText(w.endMs),
        policy: settings.overlapPolicy,
        boundary: settings.boundaryPolicy,
        basis: settings.overlapTieBasis,
        order: ordered.map((r) => r.batchId),
        slices: slices ? ordered.map((row, i) => ({
          batchId: row.batchId,
          startAt: msToText(slices[i].startMs),
          endAt: msToText(slices[i].endMs),
        })) : null,
      });
    }
  });
  const occRows = data.occupancies
    .filter((o) => o.batchId === batchId)
    .sort((a, b) => (a.startAt < b.startAt ? -1 : 1));
  return {
    occupancies: occRows,
    taggedCount: tagged.length,
    claimedInCount: claimedIn.length,
    misTaggedCount: misTagged.length,
    unresolvedCount: unresolved.length,
    tagged: tagged.sort((a, b) => (a.at < b.at ? 1 : -1)),
    claimedIn: claimedIn.sort((a, b) => (a.at < b.at ? 1 : -1)),
    unresolved: unresolved.sort((a, b) => (a.at < b.at ? 1 : -1)),
    overlaps,
  };
}

/* ---------- 设备视角的占用账时间轴 ---------- */

function decorateOccupancy(data, row) {
  const batch = batchOf(data, row.batchId);
  const probe = probeOf(data, row.probeId);
  const room = data.rooms.find((r) => r.id === row.roomId);
  const lastMs = row.probeId ? lastProbeRecordMs(data, row.probeId) : null;
  const s = toMs(row.startAt);
  const e = row.endAt ? toMs(row.endAt) : (lastMs === null ? s : Math.max(lastMs, s));
  return Object.assign({}, row, {
    batchCode: batch ? batch.code : '',
    probeCode: probe ? probe.code : '',
    roomCode: room ? room.code : '',
    open: !row.endAt,
    durationMinutes: Math.max(0, store.round((e - s) / 60000, 0)),
    currentRoomId: probe ? probe.roomId : '',
    roomMismatch: !!(row.probeId && probe && probe.roomId !== row.roomId),
  });
}

function occupancyTimeline(data, query) {
  const q = query || {};
  let rows = data.occupancies.slice();
  if (q.batchId) rows = rows.filter((o) => o.batchId === q.batchId);
  if (q.roomId) rows = rows.filter((o) => o.roomId === q.roomId);
  if (q.probeId) rows = rows.filter((o) => o.probeId === q.probeId);
  const fromMs = q.from ? toMs(q.from) : null;
  const toMsBound = q.to ? toMs(q.to) : null;

  const settings = settingsOf(data);
  const byProbe = {};
  rows.filter((o) => o.probeId).forEach((o) => {
    (byProbe[o.probeId] = byProbe[o.probeId] || []).push(o);
  });

  const devices = [];
  Object.keys(byProbe).sort().forEach((probeId) => {
    const probeRows = byProbe[probeId];
    const wins = overlapWindows(data, probeId, probeOccupancies(data, probeId))
      .filter((w) => (!fromMs || w.endMs >= fromMs) && (!toMsBound || w.startMs <= toMsBound));
    const windows = wins.map((w) => {
      const ordered = orderBatches(data, probeId, w.rows, settings.overlapTieBasis);
      const slices = settings.overlapPolicy === 'midpoint' ? midpointSlices(w, ordered) : null;
      const members = ordered.map((row, i) => {
        const slice = slices ? slices[i] : settings.overlapPolicy === 'firstWins' && i === 0
          ? { batchId: row.batchId, startMs: w.startMs, endMs: w.endMs }
          : { batchId: row.batchId, startMs: null, endMs: null };
        return {
          batchId: row.batchId,
          occupancyStartAt: row.startAt,
          sliceStartAt: slice.startMs === null ? '' : msToText(slice.startMs),
          sliceEndAt: slice.endMs === null ? '' : msToText(slice.endMs),
        };
      });
      // 窗内记录按归属口径计数
      const amap = attributionMap(data);
      let awarded = 0;
      let unresolvedInWindow = 0;
      const perBatch = {};
      ordered.forEach((row) => { perBatch[row.batchId] = 0; });
      for (const r of data.records) {
        if (r.probeId !== probeId) continue;
        const t = toMs(r.at);
        if (t < w.startMs || t > w.endMs) continue;
        const a = amap[r.id];
        if (a.status === '存疑') unresolvedInWindow += 1;
        else if (perBatch[a.resolvedBatchId] !== undefined) { perBatch[a.resolvedBatchId] += 1; awarded += 1; }
      }
      members.forEach((m) => { m.recordCount = perBatch[m.batchId] || 0; });
      return {
        probeId,
        startAt: msToText(w.startMs),
        endAt: msToText(w.endMs),
        policy: settings.overlapPolicy,
        boundary: settings.boundaryPolicy,
        basis: settings.overlapTieBasis,
        members,
        awardedCount: awarded,
        unresolvedCount: unresolvedInWindow,
      };
    });
    const probe = probeOf(data, probeId);
    devices.push({
      probeId,
      probeCode: probe ? probe.code : '',
      roomId: probe ? probe.roomId : '',
      roomCode: probe && data.rooms.find((r) => r.id === probe.roomId) ? data.rooms.find((r) => r.id === probe.roomId).code : '',
      rows: probeRows.map((o) => decorateOccupancy(data, o)).sort((a, b) => (a.startAt < b.startAt ? -1 : 1)),
      windows,
    });
  });

  return {
    policy: {
      overlapPolicy: settings.overlapPolicy,
      boundaryPolicy: settings.boundaryPolicy,
      overlapTieBasis: settings.overlapTieBasis,
    },
    occupancies: rows.map((o) => decorateOccupancy(data, o)).sort((a, b) => (a.startAt < b.startAt ? -1 : 1)),
    devices,
  };
}

// 记录时刻转文本（东八区），供切分点展示
function msToText(msVal) {
  const d = new Date(msVal + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' +
    p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
}

/* ---------- 超限：连续超出上下限的时段，回到范围内即断开 ---------- */

function segmentStats(rows, settings) {
  const segments = [];
  let current = null;
  for (const row of rows) {
    const value = Number(row.temperatureC);
    const out = value > Number(settings.upperLimitC) || value < Number(settings.lowerLimitC);
    if (out) {
      if (current) {
        current.endAt = row.at;
        current.minutes += current.lastGapMinutes || 0;
        current.peakC = value > current.peakC ? value : current.peakC;
        current.points += 1;
      } else {
        current = { startAt: row.at, endAt: row.at, minutes: 0, peakC: value, points: 1 };
        segments.push(current);
      }
      // 与上一条记录的间隔按固定记录间隔计
      current.lastGapMinutes = Number(settings.recordIntervalMinutes);
    } else {
      current = null;
    }
  }
  const longest = segments.reduce((acc, s) => (s.minutes > acc.minutes ? s : acc), { minutes: 0, startAt: '', endAt: '', peakC: 0, points: 0 });
  const total = segments.reduce((acc, s) => acc + s.minutes, 0);
  return { segments, longestMinutes: longest.minutes, longest, totalMinutes: total, segmentCount: segments.length };
}

function excursionStats(data, batchId) {
  const rows = effectiveRecords(data, batchId);
  const stats = segmentStats(rows, data.settings);
  return Object.assign({}, stats, {
    recordCount: rows.length,
    firstAt: rows.length ? rows[0].at : '',
    lastAt: rows.length ? rows[rows.length - 1].at : '',
  });
}

// 断链：相邻记录的时刻差超过门槛
function chainGaps(data, batchId) {
  const settings = data.settings;
  const rows = effectiveRecords(data, batchId);
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const minutes = store.minutesBetween(rows[i - 1].at, rows[i].at);
    if (minutes > Number(settings.chainGapMinutes)) {
      gaps.push({ from: rows[i - 1].at, to: rows[i].at, minutes, countedMinutes: Number(settings.recordIntervalMinutes) });
    }
  }
  return { gaps, gapCount: gaps.length, totalGapMinutes: gaps.reduce((acc, g) => acc + g.countedMinutes, 0) };
}

// MKT：平均动力学温度
function mktCelsius(data, batchId) {
  const settings = data.settings;
  const rows = effectiveRecords(data, batchId);
  if (!rows.length) return 0;
  const sum = rows.reduce((acc, row) => acc + Number(row.temperatureC), 0);
  return store.round(sum / rows.length, 2);
}

// 探头校准有效期
function probeValidOn(probe, day) {
  if (!probe || !probe.calibratedUntil) return true;
  return String(day) <= String(probe.calibratedUntil);
}

function expiredProbes(data, batchId, day) {
  const rows = effectiveRecords(data, batchId);
  const bad = [];
  for (const row of rows) {
    const probe = probeOf(data, row.probeId);
    if (!probe) continue;
    if (!probeValidOn(probe, String(row.at).slice(0, 10))) {
      if (!bad.some((b) => b.probeCode === probe.code)) {
        bad.push({ probeId: probe.id, probeCode: probe.code, calibratedUntil: probe.calibratedUntil, at: row.at });
      }
    }
  }
  return bad;
}

// 累计超限时长：按批次周期累计，跨月不重置
function accumulatedExcursionMinutes(data, batchId) {
  return excursionStats(data, batchId).totalMinutes;
}

function monthlyExcursionMinutes(data, batchId) {
  const rows = effectiveRecords(data, batchId);
  const firstAt = rows.length ? rows[0].at : '';
  const month = firstAt.slice(0, 7);
  const scoped = rows.filter((r) => String(r.at).slice(0, 7) === month);
  return segmentStats(scoped, data.settings).totalMinutes;
}

function unresolvedTotals(data) {
  const amap = attributionMap(data);
  let unresolved = 0;
  const perBatch = {};
  for (const r of data.records) {
    const a = amap[r.id];
    if (a.status === '存疑') {
      unresolved += 1;
      for (const b of a.watchers) perBatch[b] = (perBatch[b] || 0) + 1;
    }
  }
  return { unresolved, perBatch };
}

// 放行判定：最长超限、累计超限、断链、探头校准、归属五条
function releaseCheck(data, batch) {
  const settings = data.settings;
  const stats = excursionStats(data, batch.id);
  const chain = chainGaps(data, batch.id);
  const accumulated = monthlyExcursionMinutes(data, batch.id);
  const expired = expiredProbes(data, batch.id, batch.loadedAt ? String(batch.loadedAt).slice(0, 10) : '');
  const attribution = batchAttribution(data, batch.id);
  const conditions = [
    { key: 'longest', ok: stats.longestMinutes <= Number(settings.allowExcursionMinutes), value: stats.longestMinutes, limit: Number(settings.allowExcursionMinutes), text: '单次连续超限不超过 ' + settings.allowExcursionMinutes + ' 分钟' },
    { key: 'total', ok: accumulated <= Number(settings.allowTotalExcursionMinutes), value: accumulated, limit: Number(settings.allowTotalExcursionMinutes), text: '累计超限不超过 ' + settings.allowTotalExcursionMinutes + ' 分钟' },
    { key: 'chain', ok: chain.gapCount === 0, value: chain.gapCount, limit: 0, text: '全程没有断链' },
    {
      key: 'attribution',
      ok: attribution.unresolvedCount === 0 && attribution.misTaggedCount === 0,
      value: { unresolved: attribution.unresolvedCount, misTagged: attribution.misTaggedCount },
      limit: 0,
      text: '没有归属待定或错位的温度记录',
    },
  ];
  return {
    mkt: mktCelsius(data, batch.id),
    longestMinutes: stats.longestMinutes,
    totalMinutes: stats.totalMinutes,
    recordCount: stats.recordCount,
    firstAt: stats.firstAt,
    lastAt: stats.lastAt,
    chain,
    expiredProbes: expired,
    attribution: {
      unresolvedCount: attribution.unresolvedCount,
      misTaggedCount: attribution.misTaggedCount,
      claimedInCount: attribution.claimedInCount,
    },
    conditions,
    pass: conditions.every((c) => c.ok),
    failed: conditions.filter((c) => !c.ok).map((c) => c.key),
  };
}

module.exports = {
  toDate,
  probeOf,
  recordsOfBatch,
  effectiveRecords,
  attributionMap,
  invalidateAttribution,
  resolveRecord,
  batchAttribution,
  occupancyTimeline,
  decorateOccupancy,
  probeOccupancies,
  excursionStats,
  chainGaps,
  mktCelsius,
  probeValidOn,
  expiredProbes,
  accumulatedExcursionMinutes,
  monthlyExcursionMinutes,
  unresolvedTotals,
  releaseCheck,
};
