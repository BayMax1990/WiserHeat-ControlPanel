// WiserHeat Control Panel — local server.
// Serves the UI from ./public and proxies a small, whitelisted set of calls
// to the Drayton Wiser hub's local API (the hub doesn't allow browser CORS,
// and this keeps the hub secret out of the browser).
//
// Zero dependencies: needs Node 18+ (for global fetch).

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const dgram = require('dgram');

// Everything the panel saves goes in one data folder. By default that's ./data, with
// config.json beside server.js. Set DATA_DIR (as the Docker image does) to keep all of it,
// config.json included, in one folder that updates never touch.
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
let VERSION = 'unknown';
try { VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || VERSION; } catch { /* not shipped */ }

// Running as a Home Assistant app? The app's Dockerfile says so, and Home Assistant also always gives
// its apps a /data/options.json file, so the panel still knows if that setting goes missing. Home
// Assistant then shows the panel in its sidebar through "ingress", and its own login has already
// checked who's visiting.
const HOME_ASSISTANT = process.env.HOME_ASSISTANT_APP === '1' || fs.existsSync('/data/options.json');

const DATA_DIR = process.env.DATA_DIR || (HOME_ASSISTANT ? '/data' : '');
const DATA = DATA_DIR ? path.resolve(DATA_DIR) : path.join(ROOT, 'data');
const BACKUPS = path.join(DATA, 'backups');
const HISTORY_FILE = path.join(DATA, 'history.json');
const LAYOUT_FILE = path.join(DATA, 'layout.json');
try {
  fs.mkdirSync(BACKUPS, { recursive: true });
  fs.accessSync(DATA, fs.constants.W_OK);
} catch (e) {
  // Usually a Docker or NAS folder owned by another user. Say how to fix it, rather than crash with a stack trace.
  console.error(`Can't save to the data folder ${DATA} (${e.code || e.message}).`);
  console.error('In Docker, the panel runs as user 1000. Give it the folder with "chown -R 1000:1000 <folder>",');
  console.error('or run the container as the folder\'s owner (for example --user 99:100 on Unraid).');
  process.exit(1);
}

// Settings live in config.json, which the Settings page writes. With no config.json the
// server still starts, and the page asks for the hub's address and secret.
const CONFIG_FILE = DATA_DIR ? path.join(DATA, 'config.json') : path.join(ROOT, 'config.json');
const DEFAULTS = { title: 'Wiser Heating', hubIp: '', secret: '', host: '127.0.0.1', port: 8765, historyIntervalSeconds: 120, historyKeepHours: 168, pricePerKwh: 25, roomIcons: {} };
let config = { ...DEFAULTS };
try {
  config = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
} catch (e) {
  if (e.code !== 'ENOENT') throw new Error(`config.json couldn't be read: ${e.message}`);
}
const saveConfig = () => fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
const hubReady = () => !!(config.hubIp && config.secret);

// HOST decides who can connect: 127.0.0.1 (the default) is this computer only; 0.0.0.0 is any
// device on the network, which needs a password (see "Sign-in" below).
// In Home Assistant, ingress expects port 8099 on every address.
const PORT = Number(process.env.PORT) || (HOME_ASSISTANT ? 8099 : config.port || 8765);
const HOST = process.env.HOST || (HOME_ASSISTANT ? '0.0.0.0' : config.host || '127.0.0.1');
const EXPOSED = !['127.0.0.1', '::1', 'localhost'].includes(HOST);
const historyIntervalMs = () => (config.historyIntervalSeconds || 120) * 1000;
const historyKeepMs = () => (config.historyKeepHours || 168) * 3600 * 1000;

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
  // Write a new file and swap it in, so stopping mid-write can't leave a half-written history.
  const tmp = `${HISTORY_FILE}.tmp`;
  fs.writeFile(tmp, JSON.stringify(history), (err) => { if (!err) fs.rename(tmp, HISTORY_FILE, () => {}); });
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

// ---------------------------------------------------------------------------
// Scheduled away ("trips"). Saved in trips.json in the data folder and run by the server, so they
// switch on time with the page closed. Times are stored as moments (milliseconds since 1970).
// Weekly repeats keep the same local clock time in the home's time zone, across clock changes.
//
// trips.json: { trips: [{ id, name, start, end, warmupMinutes, tz, repeat: null | { until } }],
//               done: { "<tripId>@<start>": "started" | "ended" | "cancelled" },
//               running: null | { key, name, offAt, startedAt },
//               error: null | { at, message } }

const TRIPS_FILE = path.join(DATA, 'trips.json');
const MINUTE = 60e3, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
// How often trips are checked, and how long after switching Away on before a manual "off" counts.
// TRIPS_TEST_FAST=1 shortens both, for the automated tests only.
const TRIP_TICK = process.env.TRIPS_TEST_FAST === '1' ? 2000 : MINUTE;
const TRIP_GRACE = process.env.TRIPS_TEST_FAST === '1' ? 5000 : 3 * MINUTE;
let trips = { trips: [], done: {}, running: null, error: null };
try { trips = { ...trips, ...JSON.parse(fs.readFileSync(TRIPS_FILE, 'utf8')) }; } catch { /* no trips yet */ }
function saveTrips() {
  const tmp = `${TRIPS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(trips, null, 1));
  fs.renameSync(tmp, TRIPS_FILE);
}

const SERVER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
function validTz(tz) {
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return tz; } catch { return SERVER_TZ; }
}
// A moment's local date and time in a time zone.
function localParts(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, m: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}
// The moment a local date and time happens in a time zone (days may overflow, e.g. d: 35).
function fromLocal({ y, m, d, h, mi }, tz) {
  const wall = Date.UTC(y, m - 1, d, h, mi);
  const offsetAt = (ms) => { const p = localParts(ms, tz); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000; };
  let ms = wall - offsetAt(wall);
  ms = wall - offsetAt(ms); // settle across a clock change
  return ms;
}
const plusLocalDays = (ms, days, tz) => { const p = localParts(ms, tz); return fromLocal({ ...p, d: p.d + days }, tz); };

// A trip's away periods that overlap [from, to): { key, tripId, name, start, end, offAt }.
// offAt is when Away switches off: the return time, less the warm-up.
function tripPeriods(trip, from, to) {
  const out = [];
  const first = trip.repeat ? Math.max(0, Math.floor((from - trip.end) / (7 * DAY)) - 1) : 0;
  for (let k = first; k < first + 600; k++) {
    if (k > 0 && !trip.repeat) break;
    const start = k === 0 ? trip.start : plusLocalDays(trip.start, 7 * k, trip.tz);
    if (start >= to) break;
    if (k > 0 && trip.repeat.until && start >= trip.repeat.until) break;
    const end = k === 0 ? trip.end : plusLocalDays(trip.end, 7 * k, trip.tz);
    const offAt = Math.max(start, end - (trip.warmupMinutes || 0) * MINUTE);
    if (end > from) out.push({ key: `${trip.id}@${start}`, tripId: trip.id, name: trip.name || '', start, end, offAt, repeat: !!trip.repeat });
  }
  return out;
}
const allPeriods = (from, to) => trips.trips.flatMap((t) => tripPeriods(t, from, to)).sort((a, b) => a.start - b.start);
const finished = (key) => trips.done[key] === 'ended' || trips.done[key] === 'cancelled';

// What the page needs: the trip under way, the next one, periods to shade on the timeline, and any problem.
function tripStatus(now = Date.now()) {
  const periods = allPeriods(now - DAY, now + 9 * DAY).filter((p) => trips.done[p.key] !== 'cancelled');
  const active = trips.running ? periods.find((p) => p.key === trips.running.key) || null : null;
  const next = periods.find((p) => p.start > now && !finished(p.key) && p.key !== trips.running?.key) || null;
  return {
    active,
    next,
    periods: periods.map(({ start, offAt, name }) => ({ start, offAt, name })), // for shading the timeline
    error: trips.error,
  };
}

// Switch the hub's Away mode, the same way the page's Away switch does, and check it took.
async function setHubAway(on) {
  const limit = (await getDomain()).System?.AwayModeSetPointLimit ?? 70;
  for (const type of on ? ['Away', 2] : ['None', 0]) { // most firmware takes the name; some want the number
    try { await hub('PATCH', '/data/domain/System', { RequestOverride: { Type: type, SetPoint: on ? limit : 0 } }); } catch { continue; }
    await new Promise((r) => setTimeout(r, 1500));
    if (((await getDomain()).System?.OverrideType === 'Away') === on) return;
  }
  throw new Error(`the hub didn't switch Away ${on ? 'on' : 'off'}`);
}

// Boosts and "until the next change" temperatures are cancelled when a trip starts. Rooms set to
// Manual mode are left alone: that's a lasting choice, and Away caps them anyway.
async function cancelRoomOverrides() {
  for (const r of (await getDomain()).Room || []) {
    if (r.OverrideType && r.OverrideType !== 'None') {
      await hub('PATCH', `/data/domain/Room/${r.id}`, { RequestOverride: { Type: 'None', DurationMinutes: 0, SetPoint: 0, Originator: 'App' } });
    }
  }
}

const fmtLocal = (ms) => new Date(ms).toLocaleString('en-GB', { timeZone: SERVER_TZ, weekday: 'short', hour: '2-digit', minute: '2-digit' });

// Trip changes and the scheduler's checks take turns, so a trip can't be deleted or ended halfway
// through being switched on.
let tripLock = Promise.resolve();
function withTrips(fn) {
  const p = tripLock.then(fn, fn);
  tripLock = p.catch(() => {});
  return p;
}
let tripCheckWaiting = false;
function tripTick() {
  if (tripCheckWaiting) return tripLock; // one's already queued
  tripCheckWaiting = true;
  return withTrips(() => { tripCheckWaiting = false; return tripCheck(); });
}

async function tripCheck() {
  if (!hubReady()) return;
  const now = Date.now();
  let changed = false;
  try {
    const due = allPeriods(now - 60 * DAY, now + MINUTE).find((p) => p.start <= now && now < p.offAt && !finished(p.key));
    const run = trips.running;
    if (run && (!due || due.key !== run.key)) {
      if (due) {
        // Another trip carries straight on (or this one was edited): stay away, under the new one.
        // Check Away really is on: the panel may have stopped just after switching it off, before saving.
        if ((await getDomain()).System?.OverrideType !== 'Away') await setHubAway(true);
        trips.done[run.key] = 'ended';
        trips.running = { key: due.key, name: due.name, offAt: due.offAt, startedAt: run.startedAt };
        trips.done[due.key] = 'started';
      } else {
        await setHubAway(false);
        trips.done[run.key] = 'ended';
        trips.running = null;
        console.log(`[away] trip${run.name ? ` "${run.name}"` : ''} finished: Away off`);
      }
      trips.error = null;
      changed = true;
    } else if (run) {
      // Someone switched Away off by hand: that ends the trip. (Not straight after we switched it on.)
      if (now - run.startedAt > TRIP_GRACE && (await getDomain()).System?.OverrideType !== 'Away') {
        trips.done[run.key] = 'cancelled';
        trips.running = null;
        trips.error = null;
        changed = true;
        console.log('[away] Away was switched off by hand, so the trip has ended');
      }
    } else if (due) {
      await cancelRoomOverrides();
      await setHubAway(true);
      trips.done[due.key] = 'started';
      trips.running = { key: due.key, name: due.name, offAt: due.offAt, startedAt: now };
      trips.error = null;
      changed = true;
      console.log(`[away] trip${due.name ? ` "${due.name}"` : ''} started: Away on until ${fmtLocal(due.offAt)}`);
    }
  } catch (e) {
    const doing = trips.running ? 'switch Away off' : 'switch Away on';
    const message = `Couldn't ${doing}: ${e.message}. Still trying every minute.`;
    if (trips.error?.message !== message) console.warn(`[away] ${message}`);
    trips.error = { at: trips.error?.at || now, message };
    changed = true;
  }
  // Tidy up: one-off trips a day after they've finished, repeats a day after their last date.
  const before = trips.trips.length;
  trips.trips = trips.trips.filter((t) => {
    if (trips.running?.key.startsWith(`${t.id}@`)) return true;
    return t.repeat ? !t.repeat.until || t.repeat.until > now - DAY : t.end > now - DAY;
  });
  for (const [key] of Object.entries(trips.done)) if (Number(key.split('@')[1]) < now - 60 * DAY) delete trips.done[key];
  if (changed || trips.trips.length !== before) saveTrips();
}
setInterval(tripTick, TRIP_TICK);
setTimeout(tripTick, 5000);

const newTripId = () => `t${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;

function cleanTrip(b, id) {
  const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);
  const start = num(b.start), end = num(b.end);
  if (Number.isNaN(start) || Number.isNaN(end)) throw bad('Choose when you leave and when you get back');
  if (end <= start) throw bad('The return has to be after you leave');
  const warmupMinutes = b.warmupMinutes == null ? 180 : num(b.warmupMinutes);
  if (!(warmupMinutes >= 0 && warmupMinutes <= 24 * 60)) throw bad('The warm-up must be between 0 and 24 hours');
  if (end - warmupMinutes * MINUTE <= start) throw bad('The warm-up is as long as the trip. Choose a shorter warm-up.');
  let repeat = null;
  if (b.repeat) {
    if (end - start >= 7 * DAY) throw bad('A trip that repeats every week has to be shorter than a week');
    const until = b.repeat.until == null || b.repeat.until === '' ? null : num(b.repeat.until);
    if (until !== null && (Number.isNaN(until) || until <= start)) throw bad('The repeats have to finish after the first trip starts');
    repeat = { until };
  }
  if (!repeat && end <= Date.now()) throw bad('That trip has already finished');
  return { id, name: String(b.name ?? '').trim().slice(0, 40), start, end, warmupMinutes, tz: validTz(b.tz || SERVER_TZ), repeat };
}

// Ends the trip under way, now: switch Away off, and remember it ended early.
async function endRunningTrip() {
  const run = trips.running;
  if (!run) return;
  await setHubAway(false);
  trips.done[run.key] = 'cancelled';
  trips.running = null;
  trips.error = null;
  saveTrips();
}

// Each trip with its next (or current) away period, for the list.
function tripsOut() {
  const now = Date.now();
  const list = trips.trips.map((t) => {
    const upcoming = tripPeriods(t, now, now + 400 * DAY).find((p) => p.key === trips.running?.key || !finished(p.key)) || null;
    return { ...t, upcoming, active: !!upcoming && upcoming.key === trips.running?.key };
  });
  return { trips: list.sort((a, b) => (a.upcoming?.start ?? Infinity) - (b.upcoming?.start ?? Infinity)), status: tripStatus() };
}

async function tripsApi(req, res, m, p) {
  let match;
  if (m === 'GET' && p === '/api/trips') return send(res, 200, tripsOut());
  // Changes wait their turn with the scheduler, then check straight away, so a trip that has
  // already started switches Away on before the answer comes back.
  const change = async (fn) => withTrips(async () => { await fn(); saveTrips(); await tripCheck(); return send(res, 200, tripsOut()); });
  if (m === 'POST' && p === '/api/trips') {
    const b = await readBody(req);
    if (trips.trips.length >= 50) return send(res, 400, { error: "That's a lot of trips. Delete some old ones first." });
    const t = cleanTrip(b, newTripId());
    return change(() => { trips.trips.push(t); });
  }
  if (m === 'PUT' && (match = p.match(/^\/api\/trips\/([\w-]+)$/))) {
    const b = await readBody(req);
    if (!trips.trips.some((t) => t.id === match[1])) return send(res, 404, { error: 'That trip no longer exists' });
    const t = cleanTrip(b, match[1]);
    return change(() => { const i = trips.trips.findIndex((x) => x.id === t.id); if (i >= 0) trips.trips[i] = t; });
  }
  if (m === 'DELETE' && (match = p.match(/^\/api\/trips\/([\w-]+)$/))) {
    return change(async () => {
      if (trips.running?.key.startsWith(`${match[1]}@`)) await endRunningTrip();
      trips.trips = trips.trips.filter((t) => t.id !== match[1]);
    });
  }
  if (m === 'POST' && p === '/api/trips/home') return change(endRunningTrip);
  return false;
}

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

const publicSettings = (req) => ({
  version: VERSION, title: config.title, defaultTitle: DEFAULTS.title, hubIp: config.hubIp, hasSecret: !!config.secret, port: PORT,
  historyIntervalSeconds: config.historyIntervalSeconds, historyKeepHours: config.historyKeepHours, pricePerKwh: config.pricePerKwh, roomIcons: config.roomIcons || {},
  password: { set: passwordSet(), fromEnv: !!ENV_PASSWORD },
  network: { exposed: EXPOSED, host: HOST, urls: networkUrls(), local: isLocal(req), dataDir: DATA },
  homeAssistant: HOME_ASSISTANT,
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

// ---------------------------------------------------------------------------
// Finding the hub ("Find my hub" in setup and Settings).
//
// Wiser hubs announce themselves with multicast DNS as "WiserHeatXXXXXX", a web service on port 80.
// Inside Docker or Home Assistant those announcements can't be heard, so the panel checks each
// address on the home network instead. Asked for data without the secret, a Wiser hub always
// answers 401 {"Error":"Unauthorized"}, which is how it's recognised.

const MDNS = { address: '224.0.0.251', port: 5353 };

// This machine's own network connections (IPv4, not loopback). With realOnly, leave out virtual
// ones (WSL, Docker, virtual machines, VPNs), which never have a hub on them.
const VIRTUAL = /vethernet|wsl|docker|^br-|^veth|virbr|vmnet|vbox|virtualbox|hyper-v|tailscale|zerotier|^zt|wireguard|^wg|^tun|^tap/i;
const lanIPv4 = (realOnly = false) => Object.entries(os.networkInterfaces())
  .filter(([name]) => !realOnly || !VIRTUAL.test(name))
  .flatMap(([, addrs]) => addrs || [])
  .filter((a) => a.family === 'IPv4' && !a.internal);

function dnsQuestion(name) {
  const labels = name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]));
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4); // one question
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(12, 0); // PTR
  tail.writeUInt16BE(0x8001, 2); // class IN, asking for replies straight back to us
  return Buffer.concat([header, ...labels, Buffer.from([0]), tail]);
}

function readDnsName(buf, off) {
  const labels = [];
  let end = null;
  for (let hops = 0; hops < 32; hops++) {
    const len = buf[off];
    if (len === undefined) break;
    if (len === 0) { end ??= off + 1; break; }
    if ((len & 0xc0) === 0xc0) { end ??= off + 2; off = ((len & 0x3f) << 8) | buf[off + 1]; continue; }
    labels.push(buf.toString('utf8', off + 1, off + 1 + len));
    off += len + 1;
  }
  return [labels.join('.'), end ?? off];
}

// The answer records in a DNS message: [{ type: 'A' | 'PTR' | 'SRV', name, value }].
function dnsAnswers(buf) {
  const out = [];
  let off = 12;
  for (let i = 0; i < buf.readUInt16BE(4); i++) off = readDnsName(buf, off)[1] + 4;
  const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  for (let i = 0; i < total && off < buf.length; i++) {
    const [name, next] = readDnsName(buf, off);
    const type = buf.readUInt16BE(next), len = buf.readUInt16BE(next + 8), data = next + 10;
    if (type === 1 && len === 4) out.push({ type: 'A', name, value: [...buf.subarray(data, data + 4)].join('.') });
    if (type === 12) out.push({ type: 'PTR', name, value: readDnsName(buf, data)[0] });
    if (type === 33) out.push({ type: 'SRV', name, value: readDnsName(buf, data + 6)[0] });
    off = data + len;
  }
  return out;
}

// Listens for a couple of seconds for hubs announcing themselves. Resolves to [{ name, address }].
function mdnsFindHubs(ms = 2500) {
  return new Promise((resolve) => {
    const hubs = new Map(); // instance name -> { name, address }
    const hostIps = new Map(); // "WiserHeat037256.local" -> ip
    const srvTargets = new Map(); // instance -> host name
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { sock.close(); } catch { /* already closed */ }
      for (const [inst, hub] of hubs) hub.address = hostIps.get(srvTargets.get(inst)) || hostIps.get(`${hub.name}.local`) || hub.address;
      resolve([...hubs.values()]);
    };
    sock.on('error', finish);
    sock.on('message', (msg, from) => {
      let answers;
      try { answers = dnsAnswers(msg); } catch { return; }
      for (const a of answers) {
        if (a.type === 'A') hostIps.set(a.name.toLowerCase(), a.value);
        const inst = a.type === 'PTR' ? a.value : a.type === 'SRV' ? a.name : null;
        const label = inst?.split('.')[0] || '';
        if (!/^wiserheat/i.test(label)) continue;
        if (a.type === 'SRV') srvTargets.set(inst, a.value.toLowerCase());
        if (!hubs.has(inst)) hubs.set(inst, { name: label, address: from.address }); // the hub itself answered
      }
    });
    sock.bind(0, () => {
      // Ask on every network connection, one after another (the interface is a socket-wide setting).
      const q = dnsQuestion('_http._tcp.local');
      const ifaces = lanIPv4().map((i) => i.address);
      const next = () => {
        if (done) return;
        const ip = ifaces.shift();
        if (ip === undefined) return;
        try { sock.setMulticastInterface(ip); } catch { /* not supported here */ }
        sock.send(q, MDNS.port, MDNS.address, next);
      };
      if (ifaces.length) next(); else sock.send(q, MDNS.port, MDNS.address, () => {});
    });
    setTimeout(finish, ms);
  });
}

// Asks a device directly for its name (a unicast mDNS reverse lookup), e.g. "WiserHeat037256".
function mdnsNameOf(ip, ms = 1000) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (name) => {
      if (done) return;
      done = true;
      try { sock.close(); } catch { /* already closed */ }
      resolve(name);
    };
    sock.on('error', () => finish(null));
    sock.on('message', (msg) => {
      try {
        const ptr = dnsAnswers(msg).find((a) => a.type === 'PTR');
        if (ptr) finish(ptr.value.replace(/\.local$/i, ''));
      } catch { /* not a DNS reply */ }
    });
    sock.send(dnsQuestion(`${ip.split('.').reverse().join('.')}.in-addr.arpa`), MDNS.port, ip, (e) => { if (e) finish(null); });
    setTimeout(() => finish(null), ms);
  });
}

// Is there a Wiser hub at this address? (No secret needed or sent.)
async function looksLikeHub(ip, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://${ip}/data/domain/`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status === 401 && /"Error"\s*:\s*"Unauthorized"/.test(await res.text());
  } catch {
    return false;
  }
}

// Which home networks to check, as "a.b.c" /24 prefixes.
async function networksToScan() {
  let cidrs = [];
  if (HOME_ASSISTANT && process.env.SUPERVISOR_TOKEN) {
    // Home Assistant knows the machine's real network; the app itself only sees its own.
    try {
      const r = await fetch(`${process.env.SUPERVISOR_API || 'http://supervisor'}/network/info`, {
        headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` }, signal: AbortSignal.timeout(5000),
      });
      for (const i of (await r.json())?.data?.interfaces || []) {
        if (i.enabled === false || i.connected === false) continue;
        cidrs.push(...[].concat(i.ipv4?.address || []));
      }
    } catch (e) {
      console.warn(`[discover] couldn't ask Home Assistant for its network: ${e.message}`);
    }
  } else if (!IN_DOCKER) {
    cidrs = lanIPv4(true).map((i) => i.address);
  }
  const own = new Set(lanIPv4().map((i) => i.address));
  const prefixes = new Set();
  for (const c of cidrs) {
    const m = String(c).match(/^(\d+\.\d+\.\d+)\.(\d+)/);
    if (m && !m[1].startsWith('169.254') && !m[1].startsWith('172.30.3')) prefixes.add(m[1]); // skip link-local and Home Assistant's own
  }
  return { prefixes: [...prefixes], own };
}

async function scanForHubs() {
  const { prefixes, own } = await networksToScan();
  const ips = prefixes.flatMap((p) => Array.from({ length: 254 }, (_, i) => `${p}.${i + 1}`)).filter((ip) => !own.has(ip));
  const found = [];
  let next = 0;
  const worker = async () => {
    while (next < ips.length) {
      const ip = ips[next++];
      if (await looksLikeHub(ip)) found.push({ name: null, address: ip });
    }
  };
  await Promise.all(Array.from({ length: 48 }, worker));
  return { hubs: found, scanned: prefixes.map((p) => `${p}.0/24`) };
}

let discovering = null; // one search at a time; a second click shares the first's result
function discoverHubs(method) {
  discovering ||= (async () => {
    let hubs = method === 'scan' ? [] : await mdnsFindHubs();
    let scanned = [];
    if (!hubs.length && method !== 'mdns') ({ hubs, scanned } = await scanForHubs());
    // Double-check each one really is a hub, and drop duplicates.
    const seen = new Set();
    const checked = [];
    for (const h of hubs) {
      if (seen.has(h.address)) continue;
      seen.add(h.address);
      if (!(await looksLikeHub(h.address, 3000))) continue;
      h.name ||= await mdnsNameOf(h.address);
      checked.push(h);
    }
    const canSearch = !IN_DOCKER || (HOME_ASSISTANT && !!process.env.SUPERVISOR_TOKEN);
    return { hubs: checked, scanned, canSearch, docker: IN_DOCKER && !HOME_ASSISTANT };
  })().finally(() => { discovering = null; });
  return discovering;
}

// Tries an address and secret (or the saved ones) without saving them.
async function testHub(b) {
  const ip = b.hubIp == null || b.hubIp === '' ? config.hubIp : cleanHost(b.hubIp);
  const secret = cleanSecret(b.secret) || config.secret;
  if (!ip) throw bad("That doesn't look like a hub address. Use something like 192.168.1.50");
  if (!secret) throw bad('Paste the hub secret first');
  try {
    const d = await hubFetch(ip, secret, 'GET', '/data/domain/');
    const names = (d?.Room || []).map((r) => String(r.Name ?? '').trim()).filter(Boolean).sort((a, b) => a.localeCompare(b));
    return { rooms: d?.Room?.length ?? 0, names, firmware: d?.System?.ActiveSystemVersion || null };
  } catch (e) {
    if (e.status) throw e;
    throw Object.assign(new Error(`Couldn't reach a hub at ${ip}. Check the address, and that this computer is on the same network.`), { status: 504 });
  }
}

// ---------------------------------------------------------------------------
// HTTP

// ---------------------------------------------------------------------------
// Sign-in
//
// With no password, only this computer can use the panel, opened as http://localhost.
// Once a password is set (in Settings, on first visit from another device, or with the
// PANEL_PASSWORD environment variable), every visitor signs in, and gets a cookie that
// lasts 30 days. Changing the password signs everyone out.

const SESSION_COOKIE = 'wiser_session';
const SESSION_DAYS = 30;
const MIN_PASSWORD = 8;
const ENV_PASSWORD = process.env.PANEL_PASSWORD || '';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

const passwordSet = () => !!(ENV_PASSWORD || config.passwordHash);

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt:${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function checkPassword(pw) {
  pw = String(pw ?? '');
  if (ENV_PASSWORD) return crypto.timingSafeEqual(sha256(pw), sha256(ENV_PASSWORD));
  const [kind, salt, hash] = String(config.passwordHash || '').split(':');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  return crypto.timingSafeEqual(crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64), Buffer.from(hash, 'hex'));
}

// A session cookie is "expiry.signature". The signature covers the current password, so a new
// password makes every older cookie invalid. The signing key is created once and kept in config.json.
function sessionKey() {
  if (!config.sessionKey) { config.sessionKey = crypto.randomBytes(32).toString('hex'); saveConfig(); }
  return config.sessionKey;
}
const passwordId = () => (ENV_PASSWORD ? 'env:' + sha256(ENV_PASSWORD).toString('hex') : config.passwordHash);
const sign = (exp) => crypto.createHmac('sha256', sessionKey()).update(`${exp}.${passwordId()}`).digest('base64url');

function newSessionCookie(req) {
  const exp = Date.now() + SESSION_DAYS * 86400e3;
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}
const clearSessionCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

function signedIn(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=(\\d+)\\.([\\w-]+)`));
  if (!m || Number(m[1]) < Date.now()) return false;
  const want = Buffer.from(sign(m[1])), got = Buffer.from(m[2]);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// Is this request from the computer the panel runs on, addressed as localhost?
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const isLocal = (req) => LOOPBACK.has(req.socket.remoteAddress) && LOCAL_HOSTS.has((req.headers.host || '').replace(/:\d+$/, ''));

// Home Assistant's ingress proxy always connects from this address, and only after its own login.
const INGRESS = new Set(['172.30.32.2', '::ffff:172.30.32.2']);
const fromIngress = (req) => HOME_ASSISTANT && INGRESS.has(req.socket.remoteAddress);

// Who may use the API: 'ok', 'login' (needs to sign in), 'setup' (needs a password created first) or 'forbidden'.
function access(req) {
  // Requests sent by other websites carry their own Origin. Refuse them, so a page you visit can't
  // quietly use the panel through your browser. Behind Home Assistant, the browser's address is the
  // Home Assistant one, which the proxy passes on as X-Forwarded-Host.
  const origin = req.headers.origin;
  if (origin) {
    const hosts = [req.headers.host];
    if (fromIngress(req) && req.headers['x-forwarded-host']) hosts.push(req.headers['x-forwarded-host']);
    let ok = false;
    try { ok = hosts.includes(new URL(origin).host); } catch { /* not a URL */ }
    if (!ok) {
      if (HOME_ASSISTANT) console.warn(`[access] refused ${req.method} ${req.url}: origin ${origin}, host ${req.headers.host}, forwarded ${req.headers['x-forwarded-host'] || '-'}`);
      return 'forbidden';
    }
  }
  if (fromIngress(req)) return 'ok';
  if (passwordSet()) return signedIn(req) ? 'ok' : 'login';
  if (isLocal(req)) return 'ok';
  // No password yet. On a server that other devices can reach, the first visitor creates one.
  // On a this-computer-only install, anything not addressed as localhost is a trick (DNS rebinding).
  return EXPOSED ? 'setup' : 'forbidden';
}

// Slow down password guessing: after 5 wrong tries, lock that address out for a while.
const failures = new Map(); // ip -> { n, until }
function lockedOut(req) {
  const f = failures.get(req.socket.remoteAddress);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}
function noteFailure(req) {
  const ip = req.socket.remoteAddress;
  const f = failures.get(ip) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) f.until = Date.now() + 60e3 * Math.min(2 ** (f.n - 5), 30);
  failures.set(ip, f);
}

function validNewPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) throw bad(`Use at least ${MIN_PASSWORD} characters`);
  if (pw.length > 200) throw bad('That password is too long');
  return pw;
}

// Sign-in endpoints. These work without being signed in; everything else in the API doesn't.
async function authApi(req, res, p, state) {
  const m = req.method;
  if (m === 'GET' && p === '/api/session') {
    return send(res, 200, { access: state, passwordSet: passwordSet(), title: config.title });
  }
  if (m === 'POST' && p === '/api/login') {
    if (!passwordSet()) return send(res, 400, { error: 'No password has been set' });
    const wait = lockedOut(req);
    if (wait) return send(res, 429, { error: `Too many wrong passwords. Try again in ${wait} seconds.` });
    const { password } = await readBody(req);
    if (!checkPassword(password)) { noteFailure(req); return send(res, 401, { error: "That password isn't right", auth: 'login' }); }
    failures.delete(req.socket.remoteAddress);
    return send(res, 200, { ok: true }, { 'Set-Cookie': newSessionCookie(req) });
  }
  if (m === 'POST' && p === '/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
  if (m === 'POST' && p === '/api/auth/setup') {
    if (state !== 'setup') return send(res, 400, { error: passwordSet() ? 'A password is already set' : 'Set a password in Settings instead' });
    config.passwordHash = hashPassword(validNewPassword((await readBody(req)).password));
    saveConfig();
    return send(res, 200, { ok: true }, { 'Set-Cookie': newSessionCookie(req) });
  }
  return false;
}

// Changing or removing the password, from Settings (already signed in).
async function changePassword(req, res) {
  if (ENV_PASSWORD) return send(res, 400, { error: 'The password is set by PANEL_PASSWORD when the server starts, so change it there' });
  const { current, next } = await readBody(req);
  if (config.passwordHash) {
    const wait = lockedOut(req);
    if (wait) return send(res, 429, { error: `Too many wrong passwords. Try again in ${wait} seconds.` });
    if (!checkPassword(current)) { noteFailure(req); return send(res, 400, { error: "The current password isn't right" }); }
  }
  if (!next) {
    if (!isLocal(req)) return send(res, 400, { error: 'To remove the password, open the panel on the computer it runs on' });
    delete config.passwordHash;
    saveConfig();
    return send(res, 200, publicSettings(req), { 'Set-Cookie': clearSessionCookie() });
  }
  config.passwordHash = hashPassword(validNewPassword(next));
  saveConfig();
  return send(res, 200, publicSettings(req), { 'Set-Cookie': newSessionCookie(req) });
}

// The addresses other devices can use to reach this computer.
// Inside Docker the panel only sees the container's private address, which nobody else can reach,
// so it doesn't list addresses there (the page shows the one the browser used instead).
const IN_DOCKER = fs.existsSync('/.dockerenv');

function networkUrls() {
  if (!EXPOSED || IN_DOCKER) return [];
  if (!['0.0.0.0', '::'].includes(HOST)) return [`http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}`];
  return Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => `http://${a.address}:${PORT}`);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
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

  if (m === 'GET' && p === '/api/settings') return send(res, 200, publicSettings(req));
  if (m === 'PUT' && p === '/api/settings') {
    updateSettings(await readBody(req));
    return send(res, 200, publicSettings(req));
  }
  if (m === 'PUT' && p === '/api/auth/password') return changePassword(req, res);
  if (m === 'POST' && p === '/api/settings/test') return send(res, 200, await testHub(await readBody(req)));
  if (m === 'GET' && p === '/api/discover') return send(res, 200, await discoverHubs(url.searchParams.get('method')));

  if (m === 'GET' && p === '/api/state') {
    const domain = await getDomain();
    const schedules = await getSchedules();
    recordHistory(domain);
    return send(res, 200, { domain, schedules, layout: readLayout(), away: tripStatus(), fetchedAt: Date.now() });
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

  if (p.startsWith('/api/trips') && await tripsApi(req, res, m, p) !== false) return;

  return send(res, 404, { error: 'Unknown endpoint' });
}

// The phone app description ("Add to Home Screen"). Built here so the app is named after the
// panel's title. Addresses are relative, so it also works under Home Assistant's path.
function webManifest() {
  const name = config.title || DEFAULTS.title;
  const shortName = name.length <= 12 ? name : name.split(/\s+/)[0].slice(0, 12);
  const icon = [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }];
  return {
    id: './',
    name,
    short_name: shortName,
    description: "See and control your whole home's heating on one screen.",
    start_url: './?view=rooms',
    scope: './',
    display: 'standalone',
    background_color: '#e8ecf0',
    theme_color: '#e8ecf0',
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    // Long-press the app's icon for these.
    shortcuts: [
      { name: 'Rooms', url: './?view=rooms', icons: icon },
      { name: 'Schedules', url: './?view=schedules', icons: icon },
      { name: 'Boost rooms', short_name: 'Boost', url: './?action=boost', icons: icon },
      { name: 'Batteries', url: './?view=batteries', icons: icon },
    ],
  };
}

function serveStatic(req, res, url) {
  if (url.pathname.endsWith('/manifest.webmanifest')) {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(JSON.stringify(webManifest(), null, 1));
  }
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

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url);
  try {
    const state = access(req);
    if (state === 'forbidden') return send(res, 403, { error: 'Open the panel at http://localhost to use it' });
    if (await authApi(req, res, url.pathname, state) !== false) return;
    if (state !== 'ok') {
      return send(res, 401, { error: state === 'setup' ? 'Create a password first' : 'Sign in first', auth: state });
    }
    await api(req, res, url);
  } catch (e) {
    const status = e.status || (e.name === 'TimeoutError' || e.cause ? 504 : 500);
    const msg = e.name === 'TimeoutError' || e.cause
      ? `Couldn't reach the hub at ${config.hubIp}. Check it's powered on and on the same network.`
      : e.message;
    console.error(`[api] ${req.method} ${url.pathname}: ${e.message}`);
    send(res, status, { error: msg });
  }
}

// A specific address such as 192.168.1.20 only listens there, so also listen on localhost,
// which people naturally use on the computer itself. 0.0.0.0 and :: already include it.
if (EXPOSED && !['0.0.0.0', '::'].includes(HOST)) http.createServer(handle).listen(PORT, '127.0.0.1');

// Stop straight away when asked (docker stop, Ctrl+C, a service manager), instead of being killed
// after a timeout. Everything is already saved as it happens.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { console.log(`Stopping (${sig}).`); process.exit(0); });

http.createServer(handle).listen(PORT, HOST, () => {
  if (HOME_ASSISTANT) {
    console.log(`WiserHeat Control Panel ${VERSION} running as a Home Assistant app. Open it from the Home Assistant sidebar.${hubReady() ? ` Hub: ${config.hubIp}` : ' It will ask for your hub details.'}`);
    return;
  }
  if (IN_DOCKER) {
    console.log(`WiserHeat Control Panel ${VERSION} running in Docker, on port ${PORT} inside the container. ${hubReady() ? `Hub: ${config.hubIp}` : 'It will ask for your hub details.'}`);
    console.log('Open it at http://<your server\'s address>:<the port you published>, for example http://192.168.1.20:8765');
  } else {
    console.log(`WiserHeat Control Panel ${VERSION} running at http://localhost:${PORT}  ${hubReady() ? `(hub ${config.hubIp})` : '(open it and enter your hub details in Settings)'}`);
  }
  if (EXPOSED) {
    const urls = networkUrls();
    if (urls.length) console.log(`Other devices can open it at ${urls.join(' or ')}`);
    if (!passwordSet()) console.log('No password yet: the first person to open it will be asked to create one.');
  }
  if (DATA_DIR) console.log(`Settings and data are kept in ${DATA}`);
});
