#!/usr/bin/env node
/* 归属与隔离口径的断言脚本：只在内存里跑，不落盘。用法：node scripts/verify-attribution.js */
const assert = require('assert');
const store = require('../server/store');
const coldlib = require('../server/coldlib');

function freshData() {
  // load 只读文件；后续全部在内存中改动，不调用 save
  return store.load();
}

function statusAt(data, probeId, at) {
  const r = data.records.find((x) => x.probeId === probeId && x.at === at);
  assert(r, '找不到记录 ' + probeId + ' ' + at);
  return coldlib.resolveRecord(data, r);
}

function attributionCondition(data, batchId) {
  const batch = data.batches.find((b) => b.id === batchId);
  return coldlib.releaseCheck(data, batch).conditions.find((c) => c.key === 'attribution');
}

let passed = 0;
function check(name, fn) {
  const data = freshData();
  fn(data);
  passed += 1;
  console.log('  ✓ ' + name);
}

console.log('1) 迁移回填与老数据不被误伤');
check('回填生成设备行与探头行，在办批次探头占用开口', (d) => {
  assert(d.occupancies.length >= 11);
  const p1 = d.occupancies.find((o) => o.batchId === 'bt-0001' && o.probeId === 'pb-0001');
  assert(p1 && p1.endAt === '', '在办批次的探头占用应开口');
  const p6 = d.occupancies.find((o) => o.batchId === 'bt-0006' && o.probeId === 'pb-0003');
  assert(p6 && p6.endAt === '2026-09-06 13:45:00', '已放行批次按最后记录收口');
});
check('同一冷库不同探头的两批不算重叠，该冷库记录全部明确', (d) => {
  const tl = coldlib.occupancyTimeline(d, { roomId: 'rm-0001' });
  assert(tl.devices.every((dev) => dev.windows.length === 0));
  const probeIds = {};
  d.probes.filter((p) => p.roomId === 'rm-0001').forEach((p) => { probeIds[p.id] = true; });
  const amap = coldlib.attributionMap(d);
  const bad = d.records.filter((r) => probeIds[r.probeId] && amap[r.id].status !== '明确');
  assert.strictEqual(bad.length, 0, 'R1 不应有非明确记录');
});
check('P-03 先后两批（09-06 与 09-12）首尾不重叠', (d) => {
  const tl = coldlib.occupancyTimeline(d, { probeId: 'pb-0003' });
  // 09-08 的无主记录使 P-03 有存疑，但不应产生重叠窗
  assert.strictEqual(tl.devices[0].windows.length, 0);
});

console.log('2) 中点切分与边界（默认口径）');
check('23:00–23:45 归先占批次，00:00 起归后占批次（一串共用读数）', (d) => {
  assert.strictEqual(statusAt(d, 'pb-0004', '2026-09-14 23:45:00').resolvedBatchId, 'bt-0004');
  assert.strictEqual(statusAt(d, 'pb-0004', '2026-09-15 00:00:00').resolvedBatchId, 'bt-0007');
  assert.strictEqual(statusAt(d, 'pb-0004', '2026-09-15 00:30:00').resolvedBatchId, 'bt-0007');
});
check('同一探头同一时刻两条不同批次读数判 same-instant-conflict 存疑，两批都挂账', (d) => {
  const a = statusAt(d, 'pb-0004', '2026-09-14 23:00:00');
  assert.strictEqual(a.status, '存疑');
  assert.strictEqual(a.reason, 'same-instant-conflict');
  const c4 = attributionCondition(d, 'bt-0004').value;
  const c7 = attributionCondition(d, 'bt-0007').value;
  assert(c4.unresolved >= 1 && c4.misTagged === 4);
  assert(c7.unresolved >= 1 && c7.misTagged === 0);
});
check('先占批次名下的记录被裁给后占批次时标账外归他，放行第 5 条拦截', (d) => {
  assert.strictEqual(attributionCondition(d, 'bt-0004').ok, false);
});
check('无占用覆盖的误录记录标存疑并挂在批次账上', (d) => {
  const a = statusAt(d, 'pb-0003', '2026-09-08 10:00:00');
  assert.strictEqual(a.status, '存疑');
  assert.strictEqual(a.reason, 'no-occupancy');
  assert.strictEqual(attributionCondition(d, 'bt-0003').value.unresolved, 1);
});

console.log('3) 口径切换');
check('firstWins：窗内 00:30 的读数归先占批次', (d) => {
  d.settings.overlapPolicy = 'firstWins';
  coldlib.invalidateAttribution(d);
  assert.strictEqual(statusAt(d, 'pb-0004', '2026-09-15 00:30:00').resolvedBatchId, 'bt-0004');
});
check('suspend：窗内读数双方都存疑，两批都被拦', (d) => {
  d.settings.overlapPolicy = 'suspend';
  coldlib.invalidateAttribution(d);
  assert.strictEqual(statusAt(d, 'pb-0004', '2026-09-14 23:30:00').status, '存疑');
  assert(attributionCondition(d, 'bt-0004').value.unresolved >= 6);
  assert(attributionCondition(d, 'bt-0007').value.unresolved >= 6);
});
check('rightClosed：中点 00:00 改归先占批次', (d) => {
  d.settings.boundaryPolicy = 'rightClosed';
  coldlib.invalidateAttribution(d);
  assert.strictEqual(statusAt(d, 'pb-0004', '2026-09-15 00:00:00').resolvedBatchId, 'bt-0004');
});
check('裁决依据切到 loadedAt 时排序仍可解（bt0004 先入库占先）', (d) => {
  d.settings.overlapTieBasis = 'loadedAt';
  coldlib.invalidateAttribution(d);
  assert.strictEqual(statusAt(d, 'pb-0004', '2026-09-14 23:30:00').resolvedBatchId, 'bt-0004');
});

console.log('4) 拆分、改挂、换设备留痕、放行收口');
check('split：00:30 把后占批次的占用段后半交给先占批次后，00:45 起只剩先占批次占用，重叠窗收口到 00:30', (d) => {
  const row = d.occupancies.find((o) => o.batchId === 'bt-0007' && o.probeId === 'pb-0004');
  const res = require('../server/resources');
  assert.strictEqual(statusAt(d, 'pb-0004', '2026-09-15 00:15:00').resolvedBatchId, 'bt-0007');
  res.splitOccupancy(d, row.id, { at: '2026-09-15 00:30:00', toBatchId: 'bt-0004' });
  coldlib.invalidateAttribution(d);
  assert.strictEqual(statusAt(d, 'pb-0004', '2026-09-15 00:15:00').resolvedBatchId, 'bt-0007');
  assert.strictEqual(statusAt(d, 'pb-0004', '2026-09-15 00:45:00').resolvedBatchId, 'bt-0004');
  assert.strictEqual(statusAt(d, 'pb-0004', '2026-09-15 01:00:00').resolvedBatchId, 'bt-0004');
  const tl = coldlib.occupancyTimeline(d, { probeId: 'pb-0004' });
  assert(tl.devices[0].windows.every((w) => w.endAt <= '2026-09-15 00:30:00'));
});
check('改挂一条错位记录后，先占批次错位计数减一', (d) => {
  const res = require('../server/resources');
  const before = attributionCondition(d, 'bt-0004').value.misTagged;
  const a = coldlib.attributionMap(d);
  // 00:00 的读数挂在 bt-0004 名下、裁决给 bt-0007
  const target = d.records.find((r) => r.batchId === 'bt-0004' && r.at === '2026-09-15 00:00:00' && a[r.id].resolvedBatchId === 'bt-0007');
  assert(target, '应能找到 00:00 的错位记录');
  res.updateRecord(d, target.id, { batchId: 'bt-0007' });
  assert.strictEqual(attributionCondition(d, 'bt-0004').value.misTagged, before - 1);
});
check('批次换设备不带交接时刻报 400；带上后老段保留、新段开口', (d) => {
  const res = require('../server/resources');
  assert.throws(() => res.updateBatch(d, 'bt-0002', { roomId: 'rm-0002' }), (e) => e.status === 400);
  const oldRows = d.occupancies.filter((o) => o.batchId === 'bt-0002' && o.roomId === 'rm-0001').length;
  res.updateBatch(d, 'bt-0002', { roomId: 'rm-0002', movedAt: '2026-09-10 12:00:00' });
  assert(d.occupancies.some((o) => o.batchId === 'bt-0002' && o.roomId === 'rm-0001' && o.endAt === '2026-09-10 12:00:00'));
  assert(d.occupancies.some((o) => o.batchId === 'bt-0002' && o.roomId === 'rm-0002' && !o.endAt));
  assert(d.occupancies.filter((o) => o.batchId === 'bt-0002').length >= oldRows + 1);
});
check('拒收后该批次开口占用按 decidedAt 收口', (d) => {
  const res = require('../server/resources');
  res.decide(d, 'bt-0005', { decision: '拒收', decider: '测试员', decidedAt: '2026-09-15 18:00:00', basis: '无记录' });
  assert(d.occupancies.some((o) => o.batchId === 'bt-0005' && o.endAt === '2026-09-15 18:00:00'));
});

console.log('5) 设备级兜底');
check('同设备两批都只登记设备行、未登记探头时，该探头记录判 device-ambiguous 存疑', (d) => {
  d.occupancies = d.occupancies.filter((o) => !(o.roomId === 'rm-0001' && !o.probeId));
  d.occupancies.push({ id: 'oc-t1', batchId: 'bt-0001', roomId: 'rm-0001', probeId: '', startAt: '2026-10-01 08:00:00', endAt: '2026-10-01 12:00:00', source: 'manual', remark: '' });
  d.occupancies.push({ id: 'oc-t2', batchId: 'bt-0002', roomId: 'rm-0001', probeId: '', startAt: '2026-10-01 09:00:00', endAt: '2026-10-01 13:00:00', source: 'manual', remark: '' });
  // 临时摘掉 pb-0002 的探头占用行，模拟只占设备的情况
  d.occupancies = d.occupancies.filter((o) => !(o.batchId === 'bt-0002' && o.probeId === 'pb-0002'));
  d.records.push({ id: 'rc-t1', batchId: 'bt-0002', probeId: 'pb-0002', at: '2026-10-01 10:00:00', temperatureC: 5, source: '人工', operator: '', remark: '' });
  coldlib.invalidateAttribution(d);
  const a = coldlib.resolveRecord(d, d.records.find((r) => r.id === 'rc-t1'));
  assert.strictEqual(a.status, '存疑');
  assert.strictEqual(a.reason, 'device-ambiguous');
});
check('设备上只有一批占着、未登记探头行时，记录按设备级兜底归该批', (d) => {
  // 只保留一个干净的设备占用：去掉 pb-0002 的探头行与所有开口设备行
  d.occupancies = d.occupancies.filter((o) => o.probeId !== 'pb-0002' && !(o.roomId === 'rm-0001' && !o.probeId));
  d.occupancies.push({ id: 'oc-t3', batchId: 'bt-0001', roomId: 'rm-0001', probeId: '', startAt: '2026-10-02 08:00:00', endAt: '2026-10-02 12:00:00', source: 'manual', remark: '' });
  d.records.push({ id: 'rc-t2', batchId: 'bt-0001', probeId: 'pb-0002', at: '2026-10-02 09:00:00', temperatureC: 5, source: '人工', operator: '', remark: '' });
  coldlib.invalidateAttribution(d);
  const a = coldlib.resolveRecord(d, d.records.find((r) => r.id === 'rc-t2'));
  assert.strictEqual(a.status, '明确');
  assert.strictEqual(a.reason, 'device-level');
});

console.log('\n全部 ' + passed + ' 组断言通过。');
