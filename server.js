// WiserHeat Control Panel — local server.
// Serves the UI from ./public and proxies a small, whitelisted set of calls
// to the Drayton Wiser hub's local API (the hub doesn't allow browser CORS,
// and this keeps the hub secret out of the browser).
//
// Zero dependencies: needs Node 18+ (for global fetch).

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const BACKUPS = path.join(DATA, 'backups');
const HISTORY_FILE = path.join(DATA, 'history.json');
const LAYOUT_FILE = path.join(DATA, 'layout.json');

// Settings live in config.json, which the Settings page writes. With no config.json the
// server still starts, and the page asks for the hub's address and secret.
const CONFIG_FILE = path.join(ROOT, 'config.json');
const DEFAULTS = { title: 'Wiser Heating', hubIp: '', secret: '', port: 8765, historyIntervalSeconds: 120, historyKeepHours: 168, pricePerKwh: 25, roomIcons: {} };
let config = { ...DEFAULTS };
try {
  config = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
} catch (e) {
  if (e.code !== 'ENOENT') throw new Error(`config.json couldn't be read: ${e.message}`);
}
const saveConfig = () => fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
const hubReady = () => !!(config.hubIp && config.secret);

const PORT = Number(process.env.PORT) || config.port || 8765;
const historyIntervalMs = () => (config.historyIntervalSeconds || 120) * 1000;
const historyKeepMs = () => (config.historyKeepHours || 168) * 3600 * 1000;

fs.mkdirSync(BACKUPS, { recursive: true });

// ---------------------------------------------------------------------------
// Hub access. The hub is a small embedded device, so requests are serialised.

async function hubFetch(ip, secret, method, urlPath, body) {
  const res = await fetch(`http://${ip}${urlPath}`, {
    method,
    headers: { SECRET: secret, 'Content-Type': 'application/json;charset=UTF-8' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) {
    const msg = res.status === 401 || res.status === 403
      ? 'The hub rejected the secret. Check it in Settings.'
      : `Hub responded ${res.status} to ${method} ${urlPath}${text ? ': ' + text.slice(0, 200) : ''}`;
    throw Object.assign(new Error(msg), { status: 502 });
  }
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

let queue = Promise.resolve();
function hub(method, urlPath, body) {
  const run = async () => {
    if (!hubReady()) throw Object.assign(new Error("The hub isn't set up yet. Open Settings and enter its address and secret."), { status: 503 });
    return hubFetch(config.hubIp, config.secret, method, urlPath, body);
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

const getDomain = () => hub('GET', '/data/domain/');
const getSchedules = () => hub('GET', '/data/v2/schedules/');

// Network info, minus anything that looks like a credential.
async function getNetwork() {
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).filter(([k]) => !/pass|psk|key|secret|token/i.test(k)).map(([k, x]) => [k, strip(x)]));
    }
    return v;
  };
  return strip(await hub('GET', '/data/network/'));
}

// ---------------------------------------------------------------------------
// Temperature history (the hub keeps none locally, so we record our own).

let history = [];
try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { /* first run */ }

let lastWifiRssi = null;

// Each point: t = time, r = rooms {id: [temp, setpoint, demand%]}, h = boiler firing (1/0),
// p = smart plugs {id: [watts, total Wh]}, w = hub Wi-Fi signal (dBm).
function recordHistory(domain) {
  const t = Date.now();
  const last = history[history.length - 1];
  if (last && t - last.t < historyIntervalMs() / 2) return;
  const r = {};
  for (const room of domain.Room || []) {
    r[room.id] = [room.CalculatedTemperature, room.CurrentSetPoint, room.PercentageDemand ?? 0];
  }
  const p = {};
  for (const plug of domain.SmartPlug || []) p[plug.id] = [plug.InstantaneousDemand ?? 0, plug.CurrentSummationDelivered ?? null];
  history.push({ t, r, h: domain.HeatingChannel?.[0]?.HeatingRelayState === 'On' ? 1 : 0, p, w: lastWifiRssi });
  history = history.filter((p) => t - p.t <= historyKeepMs());
  fs.writeFile(HISTORY_FILE, JSON.stringify(history), () => {});
}

async function pollHistory() {
  if (!hubReady()) return;
  try { lastWifiRssi = (await getNetwork()).Station?.RSSI?.Current ?? null; } catch { lastWifiRssi = null; }
  try { recordHistory(await getDomain()); }
  catch (e) { console.warn('[history] ' + e.message); }
}
let historyTimer = null;
function startHistory() {
  clearInterval(historyTimer);
  historyTimer = setInterval(pollHistory, historyIntervalMs());
  pollHistory();
}
startHistory();

// ---------------------------------------------------------------------------
// Schedule backups — written automatically before every schedule change.

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

// Saves every schedule plus which room uses which, so a restore can rebuild deleted schedules too.
async function backupSchedules(reason) {
  const schedules = await getSchedules();
  const domain = await getDomain();
  const assignments = Object.fromEntries((domain.Room || []).map((r) => [r.id, r.ScheduleId ?? null]));
  const name = `${stamp()}.json`;
  fs.writeFileSync(path.join(BACKUPS, name), JSON.stringify({ reason, savedAt: Date.now(), schedules, assignments }, null, 1));
  return name;
}

function listBackups() {
  return fs.readdirSync(BACKUPS)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .map((name) => {
      try {
        const b = JSON.parse(fs.readFileSync(path.join(BACKUPS, name), 'utf8'));
        return { name, reason: b.reason, savedAt: b.savedAt };
      } catch { return null; }
    })
    .filter(Boolean);
}

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function validDay(d) {
  return d && Array.isArray(d.Time) && Array.isArray(d.DegreesC) && d.Time.length === d.DegreesC.length &&
    d.Time.every((t) => Number.isInteger(t) && t >= 0 && t <= 2359 && t % 100 < 60) &&
    d.DegreesC.every((c) => Number.isInteger(c) && (c === -200 || (c >= 50 && c <= 300)));
}

async function writeHeatingSchedules(changes) {
  const results = [];
  for (const { id, days } of changes) {
    const body = {};
    for (const day of DAYS) {
      if (!days[day]) continue;
      if (!validDay(days[day])) throw Object.assign(new Error(`Schedule ${id} ${day} is invalid`), { status: 400 });
      body[day] = days[day];
    }
    await hub('PATCH', `/data/v2/schedules/Heating/${Number(id)}`, body);
    results.push(id);
  }
  return results;
}

// Shared schedules. The hub keeps one schedule per ID; each room points at one schedule.
// "Assign" takes the complete list of rooms that should use a schedule.

const cleanName = (n) => String(n ?? '').trim().slice(0, 40);
const roomIdList = (rooms) => [...new Set((rooms || []).map(Number).filter(Number.isInteger))];

async function heatingSchedule(id) {
  const s = (await getSchedules()).Heating?.find((x) => x.id === Number(id));
  if (!s) throw Object.assign(new Error('That schedule no longer exists on the hub'), { status: 404 });
  return s;
}

async function assignRooms(id, rooms) {
  const s = await heatingSchedule(id);
  return hub('PATCH', '/data/v2/schedules/Assign', { Assignments: roomIdList(rooms), Heating: { id: s.id, Name: s.Name } });
}

async function roomsUsing(id) {
  return (await getDomain()).Room.filter((r) => r.ScheduleId === Number(id)).map((r) => r.id);
}

async function createSchedule({ name, copyFrom, days, rooms }) {
  name = cleanName(name);
  if (!name) throw Object.assign(new Error('Give the schedule a name'), { status: 400 });
  const created = await hub('POST', '/data/v2/schedules/Assign', { Assignments: [], Heating: { Name: name } });
  const id = created?.id;
  if (!id) throw new Error('The hub did not return the new schedule');
  const src = days || (copyFrom ? await heatingSchedule(copyFrom) : null);
  if (src) await writeHeatingSchedules([{ id, days: Object.fromEntries(DAYS.map((d) => [d, src[d]])) }]);
  if (rooms?.length) await assignRooms(id, rooms);
  return id;
}

async function restoreBackup(file) {
  const b = JSON.parse(fs.readFileSync(path.join(BACKUPS, file), 'utf8'));
  const current = (await getSchedules()).Heating || [];
  const idMap = {};
  for (const s of b.schedules.Heating || []) {
    const days = Object.fromEntries(DAYS.map((d) => [d, s[d]]));
    const live = current.find((x) => x.id === s.id);
    if (live) {
      if (live.Name !== s.Name) await hub('PATCH', `/data/v2/schedules/Heating/${s.id}`, { Name: s.Name });
      await writeHeatingSchedules([{ id: s.id, days }]);
      idMap[s.id] = s.id;
    } else {
      idMap[s.id] = await createSchedule({ name: s.Name, days }); // it was deleted since the backup
    }
  }
  if (b.assignments) {
    const bySchedule = {};
    for (const [roomId, schedId] of Object.entries(b.assignments)) {
      if (schedId != null && idMap[schedId]) (bySchedule[idMap[schedId]] ||= []).push(Number(roomId));
    }
    for (const [id, rooms] of Object.entries(bySchedule)) await assignRooms(id, rooms);
  }
  return Object.values(idMap);
}

// ---------------------------------------------------------------------------
// Room order and groups (Upstairs, Downstairs…). Only the panel uses these; the hub never sees them.
// { rooms: [ungrouped room ids, in order], groups: [{ id, name, rooms: [ids] }] }

function readLayout() {
  try { return JSON.parse(fs.readFileSync(LAYOUT_FILE, 'utf8')); } catch { return { rooms: [], groups: [] }; }
}

function cleanLayout(b) {
  const groups = (Array.isArray(b?.groups) ? b.groups : []).slice(0, 50)
    .map((g) => ({ id: String(g?.id ?? '').replace(/[^\w-]/g, '').slice(0, 24), name: cleanName(g?.name) || 'Group', rooms: roomIdList(g?.rooms) }))
    .filter((g) => g.id);
  return { rooms: roomIdList(b?.rooms), groups };
}

// ---------------------------------------------------------------------------
// Settings. The secret is write-only: the page is only ever told whether one is saved.

const publicSettings = () => ({
  title: config.title, hubIp: config.hubIp, hasSecret: !!config.secret, port: PORT,
  historyIntervalSeconds: config.historyIntervalSeconds, historyKeepHours: config.historyKeepHours, pricePerKwh: config.pricePerKwh, roomIcons: config.roomIcons || {},
});

// A hub address: an IP or host name, optionally with a port. "http://" and trailing slashes are dropped.
function cleanHost(v) {
  const s = String(v ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return /^[a-z0-9.-]+(:\d{1,5})?$/i.test(s) ? s : null;
}
// Secrets are long and often pasted with stray spaces or line breaks, which are never part of one.
const cleanSecret = (v) => (typeof v === 'string' ? v.replace(/\s+/g, '') : '');
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
function wholeIn(v, lo, hi, what) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`${what} must be a whole number from ${lo} to ${hi}`);
  return n;
}

function updateSettings(b) {
  const next = { ...config };
  if ('title' in b) next.title = String(b.title ?? '').trim().slice(0, 60) || DEFAULTS.title;
  if ('hubIp' in b) {
    next.hubIp = cleanHost(b.hubIp);
    if (!next.hubIp) throw bad("That doesn't look like a hub address. Use something like 192.168.1.50");
  }
  const secret = cleanSecret(b.secret);
  if (secret) next.secret = secret;
  if (b.roomIcons && typeof b.roomIcons === 'object') { // { roomId: icon name, or null for the automatic one }
    const icons = { ...(config.roomIcons || {}) };
    for (const [id, name] of Object.entries(b.roomIcons)) {
      if (!/^\d+$/.test(id)) continue;
      if (name == null || name === '') delete icons[id];
      else if (/^[a-z0-9-]{1,30}$/.test(name)) icons[id] = name;
    }
    next.roomIcons = icons;
  }
  if ('historyIntervalSeconds' in b) next.historyIntervalSeconds = wholeIn(b.historyIntervalSeconds, 30, 3600, 'The recording interval');
  if ('historyKeepHours' in b) next.historyKeepHours = wholeIn(b.historyKeepHours, 24, 24 * 90, 'The history length');
  if ('pricePerKwh' in b) {
    const v = Number(b.pricePerKwh);
    if (!(v > 0 && v < 1000)) throw bad('Enter a price between 0 and 1000 pence');
    next.pricePerKwh = Math.round(v * 100) / 100;
  }
  const intervalChanged = next.historyIntervalSeconds !== config.historyIntervalSeconds;
  const hubChanged = next.hubIp !== config.hubIp || next.secret !== config.secret;
  config = next;
  saveConfig();
  if (intervalChanged || hubChanged) startHistory();
}

// Tries an address and secret (or the saved ones) without saving them.
async function testHub(b) {
  const ip = b.hubIp == null || b.hubIp === '' ? config.hubIp : cleanHost(b.hubIp);
  const secret = cleanSecret(b.secret) || config.secret;
  if (!ip) throw bad("That doesn't look like a hub address. Use something like 192.168.1.50");
  if (!secret) throw bad('Paste the hub secret first');
  try {
    const d = await hubFetch(ip, secret, 'GET', '/data/domain/');
    return { rooms: d?.Room?.length ?? 0, firmware: d?.System?.ActiveSystemVersion || null };
  } catch (e) {
    if (e.status) throw e;
    throw Object.assign(new Error(`Couldn't reach a hub at ${ip}. Check the address, and that this computer is on the same network.`), { status: 504 });
  }
}

// ---------------------------------------------------------------------------
// HTTP

// Only answer API calls addressed to this computer, and not ones sent by other websites.
// This stops a web page you visit from reading your heating or changing the hub secret.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
function trusted(req) {
  const host = req.headers.host || '';
  if (!LOCAL_HOSTS.has(host.replace(/:\d+$/, ''))) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === host; } catch { return false; }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(Object.assign(e, { status: 400 })); } });
    req.on('error', reject);
  });
}

// Only these fields may be sent to each hub object.
const ALLOWED = {
  Room: ['Mode', 'RequestOverride', 'Name', 'WindowDetectionActive'],
  System: ['RequestOverride', 'EcoModeEnabled', 'ComfortModeEnabled', 'AwayModeSetPointLimit', 'ValveProtectionEnabled', 'PreheatTimeLimit'],
  SmartPlug: ['Mode', 'RequestOutput', 'AwayAction'],
  Device: ['DeviceLockEnabled'],
};
function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  if (!Object.keys(out).length) throw Object.assign(new Error('Nothing to send'), { status: 400 });
  return out;
}

async function api(req, res, url) {
  const m = req.method;
  const p = url.pathname;
  let match;

  if (m === 'GET' && p === '/api/settings') return send(res, 200, publicSettings());
  if (m === 'PUT' && p === '/api/settings') {
    updateSettings(await readBody(req));
    return send(res, 200, publicSettings());
  }
  if (m === 'POST' && p === '/api/settings/test') return send(res, 200, await testHub(await readBody(req)));

  if (m === 'GET' && p === '/api/state') {
    const domain = await getDomain();
    const schedules = await getSchedules();
    recordHistory(domain);
    return send(res, 200, { domain, schedules, layout: readLayout(), fetchedAt: Date.now() });
  }
  if (m === 'PUT' && p === '/api/layout') {
    const layout = cleanLayout(await readBody(req));
    fs.writeFileSync(LAYOUT_FILE, JSON.stringify(layout, null, 1));
    return send(res, 200, layout);
  }
  if (m === 'GET' && p === '/api/history') {
    const hours = Number(url.searchParams.get('hours')) || 24;
    const from = Date.now() - hours * 3600e3;
    return send(res, 200, history.filter((x) => x.t >= from));
  }
  if (m === 'GET' && p === '/api/diagnostics') {
    const network = await getNetwork();
    lastWifiRssi = network.Station?.RSSI?.Current ?? lastWifiRssi;
    return send(res, 200, { network, fetchedAt: Date.now() });
  }

  if (m === 'PATCH' && (match = p.match(/^\/api\/room\/(\d+)$/))) {
    const body = await readBody(req);
    return send(res, 200, await hub('PATCH', `/data/domain/Room/${match[1]}`, pick(body, ALLOWED.Room)));
  }
  if (m === 'PATCH' && p === '/api/system') {
    const body = await readBody(req);
    return send(res, 200, await hub('PATCH', '/data/domain/System', pick(body, ALLOWED.System)));
  }
  if (m === 'PATCH' && (match = p.match(/^\/api\/device\/(\d+)$/))) {
    const body = await readBody(req);
    return send(res, 200, await hub('PATCH', `/data/domain/Device/${match[1]}`, pick(body, ALLOWED.Device)));
  }
  if (m === 'PATCH' && (match = p.match(/^\/api\/plug\/(\d+)$/))) {
    const body = await readBody(req);
    return send(res, 200, await hub('PATCH', `/data/domain/SmartPlug/${match[1]}`, pick(body, ALLOWED.SmartPlug)));
  }

  if (m === 'PUT' && p === '/api/schedules') {
    const { changes, reason } = await readBody(req);
    if (!Array.isArray(changes) || !changes.length) return send(res, 400, { error: 'No schedule changes' });
    const backup = await backupSchedules(reason || 'Before saving schedule changes');
    const saved = await writeHeatingSchedules(changes);
    return send(res, 200, { saved, backup });
  }

  // Schedule library: create, rename, choose rooms, delete. Each backs up first.
  if (m === 'POST' && p === '/api/library') {
    const body = await readBody(req);
    const backup = await backupSchedules(`Before creating schedule “${cleanName(body.name)}”`);
    return send(res, 200, { id: await createSchedule(body), backup });
  }
  if (m === 'PATCH' && (match = p.match(/^\/api\/library\/(\d+)$/))) {
    const name = cleanName((await readBody(req)).name);
    if (!name) return send(res, 400, { error: 'Give the schedule a name' });
    const s = await heatingSchedule(match[1]);
    const backup = await backupSchedules(`Before renaming “${s.Name}” to “${name}”`);
    await hub('PATCH', `/data/v2/schedules/Heating/${s.id}`, { Name: name });
    return send(res, 200, { backup });
  }
  if (m === 'PUT' && (match = p.match(/^\/api\/library\/(\d+)\/rooms$/))) {
    const { rooms } = await readBody(req);
    const s = await heatingSchedule(match[1]);
    const backup = await backupSchedules(`Before changing which rooms use “${s.Name}”`);
    await assignRooms(s.id, rooms);
    return send(res, 200, { backup });
  }
  if (m === 'DELETE' && (match = p.match(/^\/api\/library\/(\d+)$/))) {
    const moveTo = Number(url.searchParams.get('moveTo')) || null;
    const s = await heatingSchedule(match[1]);
    const backup = await backupSchedules(`Before deleting “${s.Name}”`);
    const orphans = await roomsUsing(s.id);
    if (moveTo && orphans.length) await assignRooms(moveTo, [...(await roomsUsing(moveTo)), ...orphans]);
    await hub('DELETE', `/data/v2/schedules/Heating/${s.id}`);
    return send(res, 200, { backup });
  }

  if (m === 'GET' && p === '/api/backups') return send(res, 200, listBackups());
  if (m === 'POST' && p === '/api/backups') return send(res, 200, { name: await backupSchedules('Manual backup') });
  if (m === 'GET' && (match = p.match(/^\/api\/backups\/([\w.-]+\.json)$/))) {
    return send(res, 200, JSON.parse(fs.readFileSync(path.join(BACKUPS, match[1]), 'utf8')));
  }
  if (m === 'POST' && (match = p.match(/^\/api\/backups\/([\w.-]+\.json)\/restore$/))) {
    const before = await backupSchedules(`Before restoring ${match[1]}`);
    const saved = await restoreBackup(match[1]);
    return send(res, 200, { saved, backup: before });
  }

  return send(res, 404, { error: 'Unknown endpoint' });
}

function serveStatic(req, res, url) {
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  if (url.pathname === '/' ) file = path.join(PUBLIC, 'index.html');
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    if (path.basename(file) === 'index.html') { // the page title, from Settings
      const title = config.title.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
      buf = Buffer.from(buf.toString('utf8').replaceAll('%TITLE%', title));
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url);
  if (!trusted(req)) return send(res, 403, { error: 'Open the panel at http://localhost to use it' });
  try {
    await api(req, res, url);
  } catch (e) {
    const status = e.status || (e.name === 'TimeoutError' || e.cause ? 504 : 500);
    const msg = e.name === 'TimeoutError' || e.cause
      ? `Couldn't reach the hub at ${config.hubIp}. Check it's powered on and on the same network.`
      : e.message;
    console.error(`[api] ${req.method} ${url.pathname}: ${e.message}`);
    send(res, status, { error: msg });
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`WiserHeat Control Panel running at http://localhost:${PORT}  ${hubReady() ? `(hub ${config.hubIp})` : '(open it and enter your hub details in Settings)'}`);
});
