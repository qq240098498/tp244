const fs = require('fs');
const path = require('path');
const { AppError } = require('./errors');

const dataFile = path.join(__dirname, '..', 'data', 'db.json');

const DEFAULT_SETTINGS = {
  lowerLimitC: 2,
  upperLimitC: 8,
  allowExcursionMinutes: 30,
  allowTotalExcursionMinutes: 120,
  chainGapMinutes: 15,
  mktActivationEnergy: 83144,
  gasConstant: 8.314,
  probeCalibrationGraceDays: 0,
  recordIntervalMinutes: 15,
  // 同一探头同一时段被多个批次占用时的裁决口径
  overlapPolicy: 'midpoint', // midpoint 中点切分 | firstWins 先占者全得 | suspend 整段挂起
  boundaryPolicy: 'leftClosed', // leftClosed 左闭右开（边界归先占者） | rightClosed 左开右闭（边界归后占者）
  overlapTieBasis: 'occupyStart', // occupyStart 占用开始时刻 | loadedAt 批次入库时刻 | recordFirst 最早记录时刻
};

// 首次升级时按批次与既有温度记录回填设备占用账，之后只认账（手工删空也不重填）
function seedOccupancies(data) {
  const decidedEnd = (b) => {
    if (b.status !== '已放行' && b.status !== '已拒收') return '';
    if (b.decidedAt) return String(b.decidedAt);
    const ends = data.releases.filter((r) => r.batchId === b.id).map((r) => r.decidedAt).sort();
    return ends.length ? ends[ends.length - 1] : '';
  };
  for (const b of data.batches) {
    data.occupancies.push({
      id: nextId('oc', data.occupancies),
      batchId: b.id,
      roomId: b.roomId,
      probeId: '',
      startAt: String(b.loadedAt),
      endAt: decidedEnd(b),
      source: 'auto',
      remark: '按批次入库时刻回填的设备占用',
    });
  }
  const groups = {};
  for (const r of data.records) {
    const key = r.batchId + '|' + r.probeId;
    if (!groups[key]) groups[key] = [];
    groups[key].push(r.at);
  }
  Object.keys(groups).forEach((key) => {
    const sep = key.indexOf('|');
    const batchId = key.slice(0, sep);
    const probeId = key.slice(sep + 1);
    const batch = data.batches.find((b) => b.id === batchId);
    const times = groups[key].slice().sort();
    const batchOpen = batch && batch.status !== '已放行' && batch.status !== '已拒收';
    data.occupancies.push({
      id: nextId('oc', data.occupancies),
      batchId,
      roomId: batch ? batch.roomId : '',
      probeId,
      startAt: times[0],
      // 在办批次的探头占用保持开口，后续新记录继续落回本批
      endAt: batchOpen ? '' : times[times.length - 1],
      source: 'auto',
      remark: '按温度记录回填的探头占用',
    });
  });
  data.__occupanciesSeeded = true;
}

function normalize(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  data.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
  for (const key of ['rooms', 'probes', 'batches', 'records', 'releases', 'occupancies']) {
    if (!Array.isArray(data[key])) data[key] = [];
  }
  if (!data.__occupanciesSeeded) seedOccupancies(data);
  return data;
}

function load() {
  let text;
  try {
    text = fs.readFileSync(dataFile, 'utf8');
  } catch (err) {
    throw new AppError(500, 'DATA_UNREADABLE', '数据文件读不出来，请检查 data/db.json 是否还在');
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new AppError(500, 'DATA_UNREADABLE', '数据文件解析失败，请检查 data/db.json 的内容');
  }
  return normalize(raw);
}

function save(data) {
  const cachedAttr = data.__attrCache;
  const cachedGroups = data.__instantGroups;
  delete data.__attrCache;
  delete data.__instantGroups;
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf8');
  data.__attrCache = cachedAttr;
  data.__instantGroups = cachedGroups;
}

function nextId(prefix, list) {
  let max = 0;
  for (const item of list || []) {
    const matched = String(item.id || '').match(/(\d+)$/);
    if (matched) max = Math.max(max, Number(matched[1]));
  }
  return prefix + '-' + String(max + 1).padStart(4, '0');
}

function round(n, digits) {
  const d = digits == null ? 2 : digits;
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Number(v.toFixed(d));
}

function minutesBetween(a, b) {
  const toDate = (s) => new Date(String(s).replace(' ', 'T') + '+08:00');
  return Math.round((toDate(b) - toDate(a)) / 60000);
}

function nowText() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return now.getUTCFullYear() + '-' + p(now.getUTCMonth() + 1) + '-' + p(now.getUTCDate()) + ' ' + p(now.getUTCHours()) + ':' + p(now.getUTCMinutes()) + ':' + p(now.getUTCSeconds());
}

module.exports = { load, save, nextId, normalize, round, minutesBetween, nowText, DEFAULT_SETTINGS, dataFile };
