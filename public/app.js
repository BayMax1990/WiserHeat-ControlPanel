// WiserHeat Control Panel — front end. No build step, no framework.

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SHORT = { Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun' };
const OFF = -200;
const NO_READING = -32768;
const MIN_T = 50, MAX_T = 300, STEP_T = 5; // tenths of a degree
const POLL_MS = 30_000;

// ---------------------------------------------------------------------------
// Small helpers

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (n, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#${n}"/></svg>`;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const store = {
  get(k, d) { try { const v = localStorage.getItem('wiser.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('wiser.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

const hhmm2min = (t) => Math.floor(t / 100) * 60 + (t % 100);
const min2hhmm = (m) => Math.floor(m / 60) * 100 + (m % 60);
const fmtMin = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m) % 60).padStart(2, '0')}`;
function fmtT(c, deg = true) {
  if (c == null || c === NO_READING) return '—';
  if (c === OFF || c < MIN_T - 20) return 'Off';
  const v = c / 10;
  return (Number.isInteger(v) ? String(v) : v.toFixed(1)) + (deg ? '°' : '');
}
const round05 = (c) => Math.round(c / 5) * 5;

// Temperature colour ramp: cold blue, neutral grey around 14°, warming to red.
const STOPS = [[50, [61, 109, 176]], [100, [126, 162, 207]], [140, [199, 205, 212]], [170, [239, 182, 92]], [190, [234, 138, 56]], [210, [217, 86, 43]], [240, [168, 42, 42]]];
function heatRGB(c) {
  c = clamp(c, STOPS[0][0], STOPS[STOPS.length - 1][0]);
  for (let i = 1; i < STOPS.length; i++) {
    const [t1, a] = STOPS[i - 1], [t2, b] = STOPS[i];
    if (c <= t2) { const f = (c - t1) / (t2 - t1); return a.map((v, k) => Math.round(v + (b[k] - v) * f)); }
  }
  return STOPS[STOPS.length - 1][1];
}
const heat = (c) => (c == null || c === OFF ? null : `rgb(${heatRGB(c).join(',')})`);
function heatInk(c) {
  if (c == null || c === OFF) return 'var(--ink-2)';
  const [r, g, b] = heatRGB(c);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55 ? '#16202b' : '#ffffff';
}
const fillStyle = (c) => (c == null || c === OFF ? '' : `background:${heat(c)};color:${heatInk(c)}`);

// Icons a room can have. The hub doesn't store one, so the panel guesses from the name
// unless one is picked in Settings.
const ROOM_ICONS = [
  ['sofa', 'Sofa'], ['armchair', 'Armchair'], ['tv', 'TV'], ['bed-double', 'Double bed'], ['bed', 'Bed'], ['baby', 'Nursery'],
  ['bath', 'Bath'], ['shower-head', 'Shower'], ['toilet', 'Toilet'], ['cooking-pot', 'Kitchen'], ['utensils', 'Dining'],
  ['washing-machine', 'Utility'], ['door-open', 'Hall'], ['monitor', 'Computer'], ['briefcase', 'Office'], ['book-open', 'Books'],
  ['gamepad-2', 'Games'], ['music', 'Music'], ['shirt', 'Dressing room'], ['car', 'Garage'], ['wrench', 'Workshop'],
  ['sun', 'Conservatory'], ['lamp', 'Lamp'], ['heater', 'Radiator'], ['house', 'House'],
];

function guessRoomIcon(name) {
  const n = name.toLowerCase();
  const map = [
    [/toilet|\bwc\b|cloak/, 'toilet'], [/bath|shower|en.?suite/, 'bath'], [/kitchen/, 'cooking-pot'],
    [/dining/, 'utensils'], [/lounge|living|sitting|family/, 'sofa'], [/snug|\bden\b/, 'armchair'],
    [/nursery|baby/, 'baby'], [/mummy|daddy|master|main bed/, 'bed-double'], [/bed/, 'bed'],
    [/utility|laundry|wash/, 'washing-machine'], [/hall|landing|stair|porch/, 'door-open'],
    [/cave|games|play/, 'gamepad-2'], [/office|study/, 'monitor'], [/garage/, 'car'], [/tv|media|cinema/, 'tv'],
    [/library/, 'book-open'], [/dressing|wardrobe/, 'shirt'], [/workshop/, 'wrench'], [/music/, 'music'],
    [/conservatory|sun ?room|orangery/, 'sun'],
  ];
  return (map.find(([re]) => re.test(n)) || [0, 'heater'])[1];
}
const roomIcon = (r) => state.settings?.roomIcons?.[r.id] || guessRoomIcon(r.Name);

// ---------------------------------------------------------------------------
// State

const state = {
  domain: null,
  sched: null,
  fetchedAt: 0,
  error: null,
  loading: true,
  refreshing: false,
  history: [],
  view: store.get('view', 'schedules'),
  mode: store.get('mode', 'day'),
  schedView: store.get('schedView', 'timeline'), // 'timeline' | 'library'
  day: null,
  selected: new Set(),
  drafts: new Map(), // scheduleId -> { Monday: {Time, DegreesC}, ... }
  pendingTemps: new Map(), // roomId -> tenths
  saving: false,
  diag: null, // { network, error }
  pendingAwayCap: null,
  layout: { rooms: [], groups: [] }, // room order and groups, shared by the timeline and the Rooms tab
  settings: null, // from /api/settings; never includes the secret
  setDraft: {}, // Settings fields typed but not saved yet
  setTest: null, // result of "Test connection": { busy } | { ok, msg }
  auth: null, // null when signed in; 'login', 'setup' or 'forbidden' while the sign-in screen shows
  setupStep: null, // 0–3 while the first-run setup screen shows
  discover: null, // "Find my hub": { busy } | { hubs, docker, canSearch } | { error }
};
let editor = null;

const sys = () => state.domain?.System || {};
const rooms = () => [...(state.domain?.Room || [])].sort((a, b) => a.Name.trim().localeCompare(b.Name.trim()));
const roomById = (id) => state.domain?.Room?.find((r) => r.id === Number(id));
const roomName = (r) => r.Name.trim();
const origSched = (id) => state.sched?.Heating?.find((s) => s.id === id);
const schedFor = (r) => (r.ScheduleId ? origSched(r.ScheduleId) : null);
const roomTemp = (r) => (r.CalculatedTemperature === NO_READING ? null : r.CalculatedTemperature);
const isAway = () => sys().OverrideType === 'Away';

function today() {
  return sys().LocalDateAndTime?.Day || DAYS[(new Date().getDay() + 6) % 7];
}
function nowMin() {
  const t = sys().LocalDateAndTime?.Time;
  if (t == null) { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
  return (hhmm2min(t) + (Date.now() - state.fetchedAt) / 60000) % 1440;
}
// Hub unix seconds -> local "HH:MM" using the hub's own clock as reference.
function hubClockAt(unix) {
  const deltaMin = (unix - (sys().UnixTime || Date.now() / 1000)) / 60;
  return fmtMin(((nowMin() - (Date.now() - state.fetchedAt) / 60000 + deltaMin) % 1440 + 1440) % 1440);
}

function pickDays(s) {
  const out = {};
  for (const d of DAYS) out[d] = { Time: [...(s?.[d]?.Time || [])], DegreesC: [...(s?.[d]?.DegreesC || [])] };
  return out;
}
const daysOf = (schedId) => state.drafts.get(schedId) || pickDays(origSched(schedId));
const sameDay = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isDayEdited = (id, d) => state.drafts.has(id) && !sameDay(state.drafts.get(id)[d], pickDays(origSched(id))[d]);

function normaliseDay(points) {
  const byTime = new Map();
  for (const p of [...points].sort((a, b) => a.m - b.m)) byTime.set(p.m, p.c);
  const ms = [...byTime.keys()];
  return { Time: ms.map(min2hhmm), DegreesC: ms.map((m) => byTime.get(m)) };
}
const toPoints = (day) => (day?.Time || []).map((t, i) => ({ m: hhmm2min(t), c: day.DegreesC[i] })).sort((a, b) => a.m - b.m);

function setDraftDay(schedId, day, dayObj) {
  const next = structuredClone(daysOf(schedId));
  next[day] = dayObj;
  if (DAYS.every((d) => sameDay(next[d], pickDays(origSched(schedId))[d]))) state.drafts.delete(schedId);
  else state.drafts.set(schedId, next);
}

function pruneDrafts() {
  for (const [id, days] of state.drafts) {
    const o = origSched(id);
    if (!o || DAYS.every((d) => sameDay(days[d], pickDays(o)[d]))) state.drafts.delete(id);
  }
}

// The temperature in force just before midnight on `day` (the last change on an earlier day).
function carryInto(days, day) {
  const idx = DAYS.indexOf(day);
  for (let k = 1; k <= 7; k++) {
    const d = DAYS[(idx - k + 7) % 7];
    const p = toPoints(days[d]);
    if (p.length) return { c: p[p.length - 1].c, from: d };
  }
  return null;
}

function segmentsFor(points, carry) {
  const segs = [];
  let start = 0, cur = carry ? carry.c : null, carried = true;
  for (const p of points) {
    if (p.m > start) segs.push({ from: start, to: p.m, c: cur, carried });
    cur = p.c; start = p.m; carried = false;
  }
  segs.push({ from: start, to: 1440, c: cur, carried });
  return segs.filter((s) => s.to > s.from);
}

// ---------------------------------------------------------------------------
// API

async function api(method, url, body) {
  // Relative to the page, so it also works when Home Assistant serves the panel under its own path.
  const res = await fetch(url.replace(/^\//, ''), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.auth) lock(data.auth); // signed out, or the password was changed elsewhere
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let refreshAgain = false;
async function refresh() {
  if (state.auth) return;
  if (state.refreshing) { refreshAgain = true; return; }
  state.refreshing = true;
  $('#refreshBtn').classList.add('spin');
  try {
    const s = await api('GET', '/api/state');
    state.domain = s.domain;
    state.sched = s.schedules;
    if (s.layout && !layoutPending) state.layout = s.layout; // don't let a poll undo a drag that's still saving
    state.fetchedAt = Date.now();
    state.error = null;
    pruneDrafts();
    for (const [id, v] of state.pendingTemps) if (roomById(id)?.CurrentSetPoint === v) state.pendingTemps.delete(id);
  } catch (e) {
    state.error = e.message;
  }
  state.loading = false;
  state.refreshing = false;
  $('#refreshBtn').classList.remove('spin');
  if (!state.day) state.day = today();
  // Re-rendering mid-typing would lose the caret, so leave the page alone until the field is left.
  if (document.activeElement?.matches?.('#main input:not([type="checkbox"]), #main textarea')) { renderHeader(); renderBanner(); renderDraftBar(); }
  else renderAll();
  if (refreshAgain) { refreshAgain = false; refresh(); }
}

async function loadSettings() {
  try { state.settings = await api('GET', '/api/settings'); } catch (e) { toast(e.message, true); }
  applyTitle();
  // The unit price used to be kept in this browser. Carry it over once.
  const oldPrice = store.get('pricePerKwh', null);
  if (oldPrice != null && state.settings) {
    try { localStorage.removeItem('wiser.pricePerKwh'); } catch { /* ignore */ }
    if (oldPrice !== state.settings.pricePerKwh) await saveSettings({ pricePerKwh: oldPrice });
  }
}
const hubConfigured = () => !!(state.settings?.hubIp && state.settings?.hasSecret);
function applyTitle() {
  const t = state.settings?.title;
  if (!t) return;
  $('#appTitle').textContent = t;
  document.title = t;
}

async function loadHistory() {
  try { state.history = await api('GET', '/api/history?hours=168'); if (state.view === 'rooms' || state.view === 'diagnostics') renderMain(); } catch { /* keep old */ }
}

const settle = () => new Promise((r) => setTimeout(r, 700));
async function act(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg);
  } catch (e) {
    toast(e.message, true);
  }
  await settle();
  await refresh();
}

// ---------------------------------------------------------------------------
// Rendering: header, banner, draft bar

function renderAll() {
  renderHeader();
  renderBanner();
  renderMain();
  renderDraftBar();
}

function renderHeader() {
  for (const b of $$('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.view === state.view));
  $('#settingsBtn').setAttribute('aria-pressed', String(state.view === 'settings'));
  const d = state.domain;
  const flame = $('#brandFlame');
  $('#boostBtn').disabled = !d?.Room?.length;
  if (!d) {
    flame.classList.remove('on');
    if (state.settings && !hubConfigured()) $('#systemLine').textContent = 'Not connected to a hub yet.';
    return;
  }
  const ch = d.HeatingChannel?.[0];
  const firing = ch?.HeatingRelayState === 'On';
  flame.classList.toggle('on', firing);
  const count = d.Room?.length || 0;
  $('#systemLine').textContent = firing
    ? `Boiler firing at ${ch.PercentageDemand}% demand. ${count} rooms.`
    : `Boiler idle. ${count} rooms on the hub.`;
  updateNow();
}

function updateNow() {
  if (!state.domain) return;
  const m = nowMin();
  $('#hubClock').textContent = `${SHORT[today()]} ${fmtMin(m)}`;
  const f = m / 1440;
  for (const el of $$('.now-line')) el.style.left = `calc(var(--pl) + (100% - var(--pl) - var(--pr)) * ${f})`;
  for (const el of $$('.now-tag')) { el.style.left = `${f * 100}%`; el.textContent = fmtMin(m); }
  for (const el of $$('.now-tick')) el.style.left = `${f * 100}%`;
}

function renderBanner() {
  const el = $('#banner');
  const toSettings = state.view === 'settings' ? '' : `<button class="btn" data-act="open-settings">${icon('settings')}Settings</button>`;
  if (state.settings && !hubConfigured()) {
    el.innerHTML = `<div class="banner">${icon('settings')}<p><strong>Welcome.</strong> To get started, enter your hub's address and secret in Settings.</p>${toSettings}</div>`;
  } else if (state.error) {
    el.innerHTML = `<div class="banner error">${icon('wifi-off')}<p><strong>Can't reach the hub.</strong> ${esc(state.error)}</p>
      ${toSettings}<button class="btn" data-act="refresh">${icon('refresh-cw')}Try again</button></div>`;
  } else if (isAway()) {
    el.innerHTML = `<div class="banner">${icon('plane')}<p><strong>Away mode is on.</strong> Every room is held at ${fmtT(sys().AwayModeSetPointLimit)} or below, whatever its schedule says.</p>
      <button class="btn" data-act="away" data-on="0">${icon('house')}Turn off away mode</button></div>`;
  } else el.innerHTML = '';
}

function renderDraftBar() {
  const bar = $('#draftBar');
  const n = state.drafts.size;
  if (!n) { bar.hidden = true; return; }
  const names = rooms().filter((r) => r.ScheduleId && state.drafts.has(r.ScheduleId)).map(roomName);
  bar.hidden = false;
  bar.innerHTML = `<p>Unsaved changes to ${names.length || n} ${names.length === 1 ? 'room' : 'rooms'} <span>${esc(names.slice(0, 3).join(', '))}${names.length > 3 ? ` and ${names.length - 3} more` : ''}</span></p>
    <button class="btn" data-act="discard-all">${icon('undo-2')}Discard</button>
    <button class="btn save" data-act="save" ${state.saving ? 'disabled' : ''}>${icon('save')}${state.saving ? 'Saving…' : 'Save to hub'}</button>`;
}

function renderMain() {
  if (rowDrag) return; // re-rendering mid-drag would drop the row; the drop renders anyway
  if (state.auth) return; // the sign-in screen is drawn once, so a timer can't wipe a half-typed password
  const main = $('#main');
  const k = document.activeElement?.dataset?.k;
  document.body.classList.toggle('onboarding', state.setupStep != null);
  if (state.setupStep != null) {
    main.innerHTML = setupView();
  } else if (state.view === 'settings') {
    main.innerHTML = settingsView();
  } else if (state.loading) {
    main.innerHTML = `<div class="loading">${icon('flame')}<p>Reading your heating system…</p></div>`;
    return;
  } else if (!state.domain) {
    main.innerHTML = `<div class="empty">${icon('wifi-off')}<p>No data from the hub yet. Check the hub's address and secret in Settings.</p>
      <button class="btn" data-act="open-settings">${icon('settings')}Open Settings</button></div>`;
    return;
  } else {
    const views = { rooms: roomsView, batteries: batteriesView, diagnostics: diagnosticsView };
    main.innerHTML = (views[state.view] || schedulesView)();
  }
  if (k) $(`[data-k="${CSS.escape(k)}"]`, main)?.focus();
  updateNow();
}

// ---------------------------------------------------------------------------
// Schedules view

function bandInner(points, carry, { minLabel = 4.5, day, roomLabel } = {}) {
  return segmentsFor(points, carry).map((s) => {
    const w = ((s.to - s.from) / 1440) * 100;
    const cls = s.c == null ? 'none' : s.c === OFF ? 'off' : '';
    const tip = `<b>${esc(roomLabel || '')}${roomLabel ? ', ' : ''}${day ? esc(SHORT[day]) + ' ' : ''}${fmtMin(s.from)} to ${s.to === 1440 ? '24:00' : fmtMin(s.to)}</b><br>${s.c == null ? 'No schedule' : fmtT(s.c)}${s.carried && carry ? ` (carried over from ${carry.from})` : ''}`;
    return `<span class="seg-fill ${cls} ${s.carried ? 'carried' : ''}" style="left:${(s.from / 1440) * 100}%;width:${w}%;${fillStyle(s.c)}" data-tip="${esc(tip)}">${w >= minLabel ? (s.c == null ? '' : fmtT(s.c)) : ''}</span>`;
  }).join('');
}

function axisTicks(step = 3) {
  let out = '';
  for (let h = 0; h <= 24; h += step) out += `<span class="${h % 6 === 0 ? 'major' : ''}" style="left:${(h / 24) * 100}%">${String(h).padStart(2, '0')}:00</span>`;
  return out;
}

function schedulesView() {
  if (state.schedView === 'library') return libraryView();
  const td = today();
  const day = state.day;
  const list = rooms();
  const schedRooms = list.filter((r) => schedFor(r));
  const allSel = schedRooms.length && schedRooms.every((r) => state.selected.has(r.id));
  const isToday = state.mode === 'week' || day === td;

  const dayChips = state.mode === 'day'
    ? `<div class="days" role="group" aria-label="Day">${DAYS.map((d) => `<button class="chip ${d === td ? 'today' : ''}" aria-pressed="${d === day}" data-act="day" data-day="${d}" data-k="day-${d}">${SHORT[d]}${d === td ? ' <small>today</small>' : ''}</button>`).join('')}</div>`
    : '';

  const row = (r) => {
    const s = schedFor(r);
    const t = roomTemp(r);
    const sel = state.selected.has(r.id);
    const edited = s && state.drafts.has(s.id);
    const heating = r.PercentageDemand > 0;
    let band;
    if (!s) {
      band = `<div class="no-schedule">${icon('hand')}No schedule. This room is controlled manually.<button class="btn small" data-act="room-sched" data-room="${r.id}">${icon('calendar-days')}Choose a schedule</button></div>`;
    } else {
      const days = daysOf(s.id);
      if (state.mode === 'day') {
        band = `<button class="band" data-act="edit" data-room="${r.id}" data-day="${day}" data-k="band-${r.id}" aria-label="Edit ${esc(roomName(r))} on ${day}">${bandInner(toPoints(days[day]), carryInto(days, day), { day, roomLabel: roomName(r) })}</button>`;
      } else {
        band = `<div class="week-strips">${DAYS.map((d) => `<div class="week-strip ${d === td ? 'today' : ''}"><span class="d">${SHORT[d]}${isDayEdited(s.id, d) ? '*' : ''}</span>
          <button class="band" data-act="edit" data-room="${r.id}" data-day="${d}" aria-label="Edit ${esc(roomName(r))} on ${d}">${bandInner(toPoints(days[d]), carryInto(days, d), { minLabel: 6, day: d, roomLabel: roomName(r) })}${d === td ? '<i class="now-tick"></i>' : ''}</button></div>`).join('')}</div>`;
      }
    }
    const status = `${t == null ? 'No reading' : fmtT(t) + ' now'}, target ${fmtT(r.CurrentSetPoint)}${heating ? ` <span class="hot">${icon('flame')}${r.PercentageDemand}%</span>` : ''}`;
    return `<div class="tl-row lay-item ${sel ? 'selected' : ''}" data-room="${r.id}">
      <div class="label-col">
        <input type="checkbox" class="room-check" data-act="select" data-room="${r.id}" data-k="sel-${r.id}" ${sel ? 'checked' : ''} ${s ? '' : 'disabled'} aria-label="Select ${esc(roomName(r))}">
        <div class="room-ico">${icon(roomIcon(r))}</div>
        <div class="room-meta">
          <div class="room-name" title="${esc(roomName(r))}">${esc(roomName(r))}</div>
          <div class="room-status">${status}</div>
          ${s ? (() => {
            const shared = roomsOn(s.id).length;
            return `<button class="sched-tag" data-act="room-sched" data-room="${r.id}" data-tip="${esc(shared > 1 ? `Shared with ${roomsOn(s.id).filter((x) => x.id !== r.id).map(roomName).join(', ')}. Click to change.` : 'Click to change which schedule this room follows')}">${icon(shared > 1 ? 'layers' : 'calendar-days')}${esc(s.Name)}${shared > 1 ? ` <small>+${shared - 1}</small>` : ''}</button>`;
          })() : ''}
          ${edited ? `<button class="edited-tag" data-act="revert" data-sched="${s.id}" data-tip="Undo this room's unsaved changes">${icon('undo-2')}Edited, undo</button>` : ''}
        </div>
      </div>
      <div class="band-col">
        ${s ? `<div class="grid-lines ${state.mode === 'week' ? 'week' : ''}">${[3, 6, 9, 12, 15, 18, 21].map((h) => `<i style="left:${(h / 24) * 100}%"></i>`).join('')}</div>` : ''}
        ${band}
        ${state.mode === 'day' && isToday && s ? '<div class="now-line"></div>' : ''}
      </div>
      ${dragHandle('room', r.id, roomName(r))}
    </div>`;
  };

  return `
    <div class="toolbar">
      ${schedViewSwitch()}
      <div class="seg" role="group" aria-label="Show">
        <button data-act="mode" data-v="day" aria-pressed="${state.mode === 'day'}">${icon('calendar-clock')}One day</button>
        <button data-act="mode" data-v="week" aria-pressed="${state.mode === 'week'}">${icon('calendar-days')}Whole week</button>
      </div>
      ${dayChips}
      <div class="spacer"></div>
      <button class="btn ghost" data-act="group-new">${icon('folder-plus')}New group</button>
      <button class="btn ghost" data-act="backups">${icon('archive-restore')}Backups</button>
    </div>
    ${selectionBar(schedRooms)}
    <div class="timeline lay-root">
      <div class="tl-head">
        <div class="label-col"><input type="checkbox" class="room-check" data-act="select-all" data-k="sel-all" ${allSel ? 'checked' : ''} aria-label="Select all rooms">${state.mode === 'day' ? esc(day) : 'Each room, Monday to Sunday'}</div>
        <div class="axis ${state.mode === 'week' ? 'week' : ''}">${axisTicks()}${state.mode === 'day' && isToday ? '<span class="now-tag"></span>' : ''}</div>
      </div>
      ${layoutSections(row, { select: true })}
    </div>
    <div class="legend">
      <span class="ramp">5°<span class="ramp-bar" style="background:linear-gradient(90deg,${[50, 100, 140, 170, 190, 210, 240].map((c) => heat(c)).join(',')})"></span>24°</span>
      <span class="ramp"><span class="off-swatch"></span>Off</span>
      <span>Click a room's bar to edit it. Tick several rooms to change them together. Drag the handle on the right to reorder rooms or move them into a group.</span>
    </div>`;
}

function selectionBar(schedRooms) {
  const sel = schedRooms.filter((r) => state.selected.has(r.id));
  if (!sel.length) return '';
  const scope = state.mode === 'day' ? state.day : 'the whole week';
  return `<div class="selection-bar">
    <span class="count">${sel.length} ${sel.length === 1 ? 'room' : 'rooms'} selected</span>
    <button class="btn solid" data-act="edit-together">${icon('sliders-horizontal')}Edit together</button>
    <select data-act="copy-week" aria-label="Copy a whole week from another room" data-k="copy-week">
      <option value="">Copy week from…</option>
      ${schedRooms.map((r) => `<option value="${r.id}">${esc(roomName(r))}</option>`).join('')}
    </select>
    <span class="sep"></span>
    <button class="btn" data-act="nudge" data-d="-5" data-tip="Every temperature on ${esc(scope)}, 0.5° cooler">${icon('snowflake')}0.5° cooler</button>
    <button class="btn" data-act="nudge" data-d="5" data-tip="Every temperature on ${esc(scope)}, 0.5° warmer">${icon('flame')}0.5° warmer</button>
    <button class="btn" data-act="shift" data-d="-15" data-tip="Every change on ${esc(scope)}, 15 minutes earlier">${icon('chevron-left')}15 min earlier</button>
    <button class="btn" data-act="shift" data-d="15" data-tip="Every change on ${esc(scope)}, 15 minutes later">15 min later${icon('chevron-right')}</button>
    <span class="spacer" style="flex:1"></span>
    <button class="btn" data-act="clear-sel" aria-label="Clear selection">${icon('x')}</button>
  </div>`;
}

function selectedSchedRooms() {
  return rooms().filter((r) => state.selected.has(r.id) && schedFor(r));
}

function bulkEdit(fn) {
  const days = state.mode === 'day' ? [state.day] : DAYS;
  const done = new Set();
  for (const r of selectedSchedRooms()) {
    if (done.has(r.ScheduleId)) continue;
    done.add(r.ScheduleId);
    const cur = daysOf(r.ScheduleId);
    for (const d of days) setDraftDay(r.ScheduleId, d, normaliseDay(fn(toPoints(cur[d]))));
  }
  renderMain();
  renderDraftBar();
}

// ---------------------------------------------------------------------------
// Rooms view

const ORIGIN = {
  FromSchedule: 'Following schedule',
  FromManualMode: 'Manual',
  FromBoost: 'Boost',
  FromAwayMode: 'Held down by away mode',
  FromManualOverride: 'Until the next scheduled change',
  FromManualOverrideDuringAway: 'Override during away mode',
  FromEcoIQ: 'Adjusted by eco mode',
  FromComfortMode: 'Pre-heating (comfort mode)',
};

function roomMode(r) {
  if (r.Mode === 'Manual' && r.CurrentSetPoint === OFF) return 'off';
  return r.Mode === 'Manual' ? 'manual' : 'auto';
}
function overrideInfo(r) {
  if (!r.OverrideType || r.OverrideType === 'None') return null;
  if (r.OverrideTimeoutUnixTime) return { boost: true, until: hubClockAt(r.OverrideTimeoutUnixTime) };
  return { boost: false };
}

function roomsView() {
  const d = state.domain;
  const ch = d.HeatingChannel?.[0] || {};
  const firing = ch.HeatingRelayState === 'On';
  const s = sys();
  const anyOverride = d.Room.some((r) => overrideInfo(r));
  const plugs = d.SmartPlug || [];

  const strip = `<div class="system-strip">
    <div class="boiler ${firing ? 'on' : ''}">
      <div class="flame-ico">${icon('flame')}</div>
      <div><b>${firing ? 'Boiler firing' : 'Boiler idle'}</b><small>${ch.PercentageDemand ? `${ch.PercentageDemand}% demand` : 'No room is calling for heat'}</small></div>
    </div>
    ${switchHTML('away', isAway(), 'plane', 'Away', `Holds every room at ${fmtT(s.AwayModeSetPointLimit)} or below`)}
    ${switchHTML('eco', !!s.EcoModeEnabled, 'leaf', 'Eco', 'Lets the hub turn heating off early when a room will coast to temperature')}
    ${switchHTML('comfort', !!s.ComfortModeEnabled, 'sun', 'Comfort', 'Pre-heats so rooms reach their target by the scheduled time')}
    <span class="strip-sep"></span>
    <button class="btn" data-act="cancel-all" ${anyOverride ? '' : 'disabled'}>${icon('rotate-ccw')}Cancel all boosts</button>
    <button class="btn ghost" data-act="group-new">${icon('folder-plus')}New group</button>
  </div>`;

  const plugHTML = plugs.length ? `<h2 class="section-title">${icon('plug')}Smart plugs</h2>
    <div class="plug-list">${plugs.map((p) => {
      const on = p.OutputState === 'On';
      const room = roomById(p.RoomId);
      const status = [on ? 'On' : 'Off', p.ControlSource === 'FromAwayMode' ? 'held off by away mode' : p.Mode === 'Auto' ? 'following its schedule' : 'set by hand'].join(', ');
      return `<div class="plug">
        <div class="plug-head">
          <div class="room-ico ${on ? 'on' : ''}">${icon(on ? 'plug-zap' : 'plug')}</div>
          <div class="grow"><b>${esc(p.Name)}${room ? ` <span>in ${esc(roomName(room))}</span>` : ''}</b><small>${status}</small></div>
        </div>
        <div class="plug-actions">
          <div class="seg mode-seg" role="group" aria-label="${esc(p.Name)} mode">
            <button data-act="plug-mode" data-plug="${p.id}" data-v="Auto" aria-pressed="${p.Mode === 'Auto'}">${icon('calendar-clock')}Auto</button>
            <button data-act="plug-mode" data-plug="${p.id}" data-v="Manual" aria-pressed="${p.Mode === 'Manual'}">${icon('hand')}Manual</button>
          </div>
          <button class="btn small" data-act="plug-out" data-plug="${p.id}" data-v="${on ? 'Off' : 'On'}">${icon('power')}${on ? 'Turn off' : 'Turn on'}</button>
        </div>
      </div>`;
    }).join('')}</div>` : '';

  return strip + `<div class="card-layout lay-root">${layoutSections(cardHTML, { bodyClass: 'room-grid' })}</div>` + plugHTML;
}

function switchHTML(key, on, ico, label, tip) {
  return `<button class="switch" role="switch" aria-checked="${on}" data-act="${key}" data-on="${on ? 0 : 1}" data-tip="${esc(tip)}" data-k="sw-${key}">
    <span class="track"></span>${icon(ico)}${label}</button>`;
}

function cardHTML(r) {
  const t = roomTemp(r);
  const mode = roomMode(r);
  const ov = overrideInfo(r);
  const pend = state.pendingTemps.get(r.id);
  const target = pend ?? r.CurrentSetPoint;
  const s = schedFor(r);
  const stat = r.RoomStatId ? state.domain.RoomStat?.find((x) => x.id === r.RoomStatId) : null;
  const next = s?.Next;
  const flags = [];
  if (r.PercentageDemand > 0) flags.push(`<span class="hot" data-tip="Valve open ${r.PercentageDemand}%">${icon('flame')}${r.PercentageDemand}%</span>`);
  if (r.WindowState === 'Open') flags.push(`<span class="alert">${icon('wind')}Window open</span>`);
  if (t == null) flags.push(`<span class="alert" data-tip="The room's thermostat or valve isn't reporting. Check its batteries.">${icon('circle-alert')}No reading</span>`);
  const weak = batteryDevices().filter((b) => b.room?.id === r.id && b.status.level !== 'good' && b.status.level !== 'unknown');
  if (weak.length) flags.push(`<span class="${weak.some((b) => b.status.level === 'critical') ? 'alert' : 'warn'}" data-tip="${esc(weak.map((b) => `${b.kind}: ${b.status.label}`).join('<br>'))}">${icon('battery-warning')}Battery</span>`);

  let origin = ORIGIN[r.SetpointOrigin] || (r.SetpointOrigin || '').replace(/^From/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
  if (ov?.boost) origin = `Boosted until ${ov.until}`;
  if (pend != null) origin = 'Sending…';

  const side = [];
  if (stat?.MeasuredHumidity != null) side.push(`<span data-tip="Humidity from the room thermostat">${icon('droplets')}${stat.MeasuredHumidity}% humidity</span>`);
  if (next && mode === 'auto') side.push(`<span data-tip="Next scheduled change">${icon('clock')}Next: ${fmtT(next.DegreesC)} at ${next.Day !== today() ? SHORT[next.Day] + ' ' : ''}${fmtMin(hhmm2min(next.Time))}</span>`);

  const canUp = target === OFF || target < MAX_T;
  const canDown = target !== OFF;

  return `<article class="card lay-item" data-room="${r.id}" style="--accent:${heat(r.CurrentSetPoint) || 'var(--line)'}">
    <div class="card-head">
      <div class="room-ico">${icon(roomIcon(r))}</div>
      <div class="room-name">${esc(roomName(r))}</div>
      <div class="card-flags">${flags.join('')}</div>
      ${dragHandle('room', r.id, roomName(r))}
    </div>
    <div class="readout">
      <div class="big-temp ${t == null ? 'na' : ''}">${t == null ? '—' : `${fmtT(t, false)}<sup>°</sup>`}</div>
      <div class="target"><b>Target ${fmtT(r.CurrentSetPoint)}</b><small>${esc(origin)}</small></div>
    </div>
    ${side.length ? `<div class="card-meta">${side.join('')}</div>` : ''}
    ${sparkHTML(r)}
    <div class="controls">
      <div class="seg mode-seg" role="group" aria-label="${esc(roomName(r))} mode">
        <button data-act="room-mode" data-room="${r.id}" data-v="auto" aria-pressed="${mode === 'auto'}" data-tip="Follow the schedule">${icon('calendar-clock')}Auto</button>
        <button data-act="room-mode" data-room="${r.id}" data-v="manual" aria-pressed="${mode === 'manual'}" data-tip="Hold one temperature">${icon('hand')}Manual</button>
        <button data-act="room-mode" data-room="${r.id}" data-v="off" aria-pressed="${mode === 'off'}" data-tip="Turn this room off">${icon('power')}Off</button>
      </div>
      <div class="stepper ${pend != null ? 'pending' : ''}" data-tip="${mode === 'auto' ? 'Changes the temperature until the next scheduled change' : 'Sets the manual temperature'}">
        <button data-act="temp" data-room="${r.id}" data-d="-5" data-k="tm-${r.id}" ${canDown ? '' : 'disabled'} aria-label="Cooler">${icon('minus')}</button>
        <output>${fmtT(target)}</output>
        <button data-act="temp" data-room="${r.id}" data-d="5" data-k="tp-${r.id}" ${canUp ? '' : 'disabled'} aria-label="Warmer">${icon('plus')}</button>
      </div>
      ${ov
        ? `<button class="btn small boost-btn active" data-act="cancel-boost" data-room="${r.id}" data-tip="${ov.boost ? 'Cancel the boost' : 'Go back to the schedule'}">${icon(ov.boost ? 'flame' : 'rotate-ccw')}${ov.boost ? `Until ${ov.until}` : 'Back to schedule'}${icon('x')}</button>`
        : `<button class="btn small boost-btn" data-act="boost-open" data-room="${r.id}">${icon('flame')}Boost</button>`}
    </div>
  </article>`;
}

function sparkHTML(r) {
  const now = Date.now(), span = 24 * 3600e3, from = now - span;
  const pts = state.history.filter((p) => p.t >= from && p.r[r.id]).map((p) => ({ t: p.t, temp: p.r[r.id][0], sp: p.r[r.id][1], d: p.r[r.id][2] }));
  const valid = pts.filter((p) => p.temp !== NO_READING);
  if (valid.length < 2 || valid[valid.length - 1].t - valid[0].t < 45 * 60e3) {
    const since = state.history[0] ? new Date(state.history[0].t) : null;
    return `<div class="spark-empty">${roomTemp(r) == null ? 'No temperature readings to chart' : `Recording temperatures${since ? ` since ${fmtMin(since.getHours() * 60 + since.getMinutes())}` : ''}. The graph fills in over the day.`}</div>`;
  }
  const vals = valid.map((p) => p.temp).concat(pts.filter((p) => p.sp >= MIN_T).map((p) => p.sp));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 30) { const mid = (hi + lo) / 2; lo = mid - 15; hi = mid + 15; }
  const W = 300, H = 56, x = (t) => ((t - from) / span) * W, y = (v) => H - 3 - ((v - lo) / (hi - lo)) * (H - 6);
  const gap = 20 * 60e3;
  let tp = '', prev = null;
  for (const p of valid) { tp += `${!prev || p.t - prev.t > gap ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.temp).toFixed(1)}`; prev = p; }
  let sp = ''; prev = null;
  for (const p of pts) {
    if (p.sp < MIN_T) { prev = null; continue; }
    sp += !prev || p.t - prev.t > gap ? `M${x(p.t).toFixed(1)},${y(p.sp).toFixed(1)}` : `H${x(p.t).toFixed(1)}V${y(p.sp).toFixed(1)}`;
    prev = p;
  }
  let rects = '';
  for (let i = 0; i < pts.length - 1; i++) {
    if (pts[i].d > 0 && pts[i + 1].t - pts[i].t <= gap) rects += `<rect class="heat-rect" x="${x(pts[i].t).toFixed(1)}" y="0" width="${(x(pts[i + 1].t) - x(pts[i].t)).toFixed(1)}" height="${H}"/>`;
  }
  return `<div class="spark" data-spark="${r.id}">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Temperature over the last 24 hours">${rects}
        <path class="s-line" d="${sp}" vector-effect="non-scaling-stroke"/>
        <path class="t-line" d="${tp}" vector-effect="non-scaling-stroke"/></svg>
      <div class="spark-cross" hidden></div><div class="spark-dot" hidden></div>
    </div>
    <div class="spark-key"><span><i></i>Room</span><span><i class="dash"></i>Target</span><span><i class="blk"></i>Heating</span><span style="margin-left:auto">Last 24 hours</span></div>`;
}

function sparkHover(e) {
  const box = e.target.closest('.spark');
  if (!box) return;
  const r = roomById(box.dataset.spark);
  const rect = box.getBoundingClientRect();
  const span = 24 * 3600e3, from = Date.now() - span;
  const t = from + ((e.clientX - rect.left) / rect.width) * span;
  const pts = state.history.filter((p) => p.t >= from && p.r[r.id] && p.r[r.id][0] !== NO_READING);
  if (!pts.length) return;
  const p = pts.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
  const [temp, sp, dem] = p.r[r.id];
  const vals = pts.map((q) => q.r[r.id][0]).concat(state.history.filter((q) => q.t >= from && q.r[r.id]?.[1] >= MIN_T).map((q) => q.r[r.id][1]));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 30) { const mid = (hi + lo) / 2; lo = mid - 15; hi = mid + 15; }
  const fx = (p.t - from) / span, fy = 1 - (3 + ((temp - lo) / (hi - lo)) * 50) / 56;
  const cross = $('.spark-cross', box), dot = $('.spark-dot', box);
  cross.hidden = dot.hidden = false;
  cross.style.left = dot.style.left = `${fx * 100}%`;
  dot.style.top = `${fy * 100}%`;
  const d = new Date(p.t);
  showTip(`<b>${fmtMin(d.getHours() * 60 + d.getMinutes())}</b><br>Room ${fmtT(temp)}, target ${fmtT(sp)}${dem ? `<br>Heating ${dem}%` : ''}`, e);
}

// ---------------------------------------------------------------------------
// Batteries view

// The hub reports voltage in tenths of a volt. These ranges (empty, full) turn it into a
// rough percentage, in line with what the Home Assistant Wiser integration uses.
const BATTERY_RANGE = { iTRV: [25, 30], RoomStat: [17, 27] };
const HUB_LEVEL = { Normal: 'Normal', TwoThirds: 'Two thirds', OneThird: 'One third', Low: 'Low' };
const KIND = { iTRV: 'Radiator valve', RoomStat: 'Room thermostat' };

function batteryPct(d) {
  if (d.BatteryVoltage == null) return null;
  const [lo, hi] = BATTERY_RANGE[d.ProductType] || BATTERY_RANGE.iTRV;
  return clamp(Math.round(((d.BatteryVoltage - lo) / (hi - lo)) * 100), 0, 100);
}

function batteryStatus(d, pct) {
  if (!d.DisplayedSignalStrength) return { level: 'critical', offline: true, label: 'Not reporting', tip: 'The hub has lost contact. Usually the batteries are flat, or the device is out of range.' };
  if (pct == null) return { level: 'unknown', label: 'Waiting for a reading', tip: 'Connected, but no battery reading yet. It appears after the device next reports, often within a few hours.' };
  if (pct <= 20 || d.BatteryLevel === 'Low') return { level: 'critical', label: 'Replace now', tip: 'The device may stop working soon.' };
  if (pct <= 45 || d.BatteryLevel === 'OneThird') return { level: 'warn', label: 'Replace soon', tip: 'Worth changing in the next few weeks.' };
  return { level: 'good', label: 'Good', tip: '' };
}

function batteryDevices() {
  const devices = (state.domain?.Device || []).filter((d) => BATTERY_RANGE[d.ProductType]);
  const list = devices.map((d) => {
    const room = d.ProductType === 'RoomStat'
      ? state.domain.Room.find((r) => r.RoomStatId === d.id)
      : state.domain.Room.find((r) => (r.SmartValveIds || []).includes(d.id));
    const pct = batteryPct(d);
    return { d, room, pct, status: batteryStatus(d, pct), kind: KIND[d.ProductType] || d.ProductType };
  });
  // Number the valves when a room has more than one.
  for (const b of list) {
    const same = list.filter((x) => x.room && x.room === b.room && x.d.ProductType === b.d.ProductType);
    if (same.length > 1) b.kind += ` ${same.indexOf(b) + 1}`;
  }
  const rank = { critical: 0, warn: 1, unknown: 2, good: 3 };
  const name = (b) => (b.room ? roomName(b.room) : '~');
  return list.sort((a, b) => rank[a.status.level] - rank[b.status.level] || (a.pct ?? -1) - (b.pct ?? -1) || name(a).localeCompare(name(b)));
}

const SIGNAL = { VeryGood: 'Very good', Good: 'Good', Medium: 'Fair', Poor: 'Poor' };
function signalIcon(d) {
  const s = d.DisplayedSignalStrength;
  if (s === 'Online') { // Mains devices only say "Online", so judge them by signal strength.
    const rssi = d.ReceptionOfDevice?.Rssi ?? d.ReceptionOfController?.Rssi;
    return rssi == null ? 'signal-medium' : rssi >= -60 ? 'signal-high' : rssi >= -72 ? 'signal-medium' : 'signal-low';
  }
  return !s ? 'signal-zero' : s === 'VeryGood' ? 'signal-high' : s === 'Good' ? 'signal-medium' : 'signal-low';
}

function batteriesView() {
  const list = batteryDevices();
  const offline = list.filter((b) => b.status.offline).length;
  const replace = list.filter((b) => (b.status.level === 'critical' && !b.status.offline) || b.status.level === 'warn').length;
  const good = list.filter((b) => b.status.level === 'good').length;
  const tiles = [
    ['good', 'battery-full', good, 'Good'],
    ['warn', 'battery-low', replace, replace === 1 ? 'Needs batteries soon' : 'Need batteries soon'],
    ['critical', 'wifi-off', offline, 'Not reporting'],
  ];
  const rows = list.map((b) => {
    const { d, room, pct, status } = b;
    const v = d.BatteryVoltage != null ? `${(d.BatteryVoltage / 10).toFixed(1)} V` : '';
    const rssi = d.ReceptionOfController?.Rssi ?? d.ReceptionOfDevice?.Rssi;
    const statusIcon = status.level === 'good' ? 'check' : status.level === 'unknown' ? 'clock' : status.offline ? 'wifi-off' : 'battery-warning';
    return `<div class="batt-row ${status.level}">
      <div class="room-ico">${icon(room ? roomIcon(room) : 'heater')}</div>
      <div class="batt-name"><b>${room ? esc(roomName(room)) : 'Not in a room'}</b><small>${esc(b.kind)}</small></div>
      <div class="batt-gauge" ${pct == null ? '' : `role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Battery about ${pct}%"`}>
        <div class="batt-track"><span style="width:${pct ?? 0}%"></span></div>
        <b>${pct == null ? '—' : `${pct}%`}</b>
      </div>
      <div class="batt-detail">${v ? `${v}<small>Hub rates it: ${esc(HUB_LEVEL[d.BatteryLevel] || d.BatteryLevel || 'unknown')}</small>` : '<small>No voltage reported</small>'}</div>
      <div class="batt-signal" data-tip="${rssi != null ? `Signal ${rssi} dBm` : 'No signal'}">${icon(signalIcon(d))}${esc(SIGNAL[d.DisplayedSignalStrength] || 'No signal')}</div>
      <div class="batt-status" ${status.tip ? `data-tip="${esc(status.tip)}"` : ''}>${icon(statusIcon)}${status.label}</div>
    </div>`;
  }).join('');
  return `<div class="batt-tiles">${tiles.map(([lvl, ico, n, label]) => `<div class="batt-tile ${lvl} ${n ? '' : 'zero'}">${icon(ico)}<b>${n}</b><span>${label}</span></div>`).join('')}</div>
    <div class="batt-list">
      <div class="batt-row head"><span></span><span>Device</span><span>Battery</span><span>Voltage</span><span>Signal</span><span>Status</span></div>
      ${rows || '<div class="empty">No battery-powered devices found.</div>'}
    </div>
    <p class="batt-note">Percentages are estimated from each device's battery voltage. Valves count 2.5 V as empty and 3.0 V as full. Thermostats count 1.7 V as empty and 2.7 V as full. The hub only checks batteries every few hours, so new batteries can take a while to show.</p>`;
}

// ---------------------------------------------------------------------------
// Diagnostics view

const DIAG_SECTIONS = [
  ['d-health', 'wifi', 'Hub health'],
  ['d-mesh', 'signal-high', 'Radio network'],
  ['d-energy', 'zap', 'Plug energy'],
  ['d-boiler', 'flame', 'Boiler'],
  ['d-tidy', 'circle-alert', 'Tidy-up'],
  ['d-valves', 'heater', 'Valves'],
  ['d-info', 'sun', 'Hub info'],
];

async function loadDiagnostics() {
  try {
    const d = await api('GET', '/api/diagnostics');
    state.diag = { network: d.network, error: null };
  } catch (e) {
    state.diag = { ...(state.diag || {}), error: e.message };
  }
  if (state.view === 'diagnostics') renderMain();
}

const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-GB'));
const pct1 = (a, b) => (b ? `${((a / b) * 100).toFixed(a / b < 0.01 ? 2 : 1)}%` : '—');
function fmtDur(sec) {
  if (sec == null) return '—';
  sec = Math.round(sec);
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d >= 365) return `${(d / 365).toFixed(1)} years`;
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  return m ? `${m} min` : `${sec} s`;
}
const fmtHours = (ms) => {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};
function wifiQuality(rssi) {
  if (rssi == null) return { label: 'Unknown', level: 'unknown' };
  if (rssi >= -55) return { label: 'Excellent', level: 'good' };
  if (rssi >= -67) return { label: 'Good', level: 'good' };
  if (rssi >= -75) return { label: 'Fair', level: 'warn' };
  return { label: 'Poor', level: 'critical' };
}
const clockOf = (t) => { const d = new Date(t); return fmtMin(d.getHours() * 60 + d.getMinutes()); };
const hhmmStr = (t) => fmtMin(hhmm2min(t));

// History points with the time each one "covers" (until the next point, capped for gaps).
function historySpans(fromT) {
  const pts = state.history.filter((p) => p.t >= fromT);
  const cap = 10 * 60e3;
  return pts.map((p, i) => ({ p, dt: Math.min((pts[i + 1]?.t ?? Math.min(Date.now(), p.t + 120e3)) - p.t, cap) }));
}

// A small line chart with hover slices. `series` = [{t, v}], one series only.
function miniLine(series, { from, to, fmt, height = 70, lo, hi, cls = '' }) {
  if (series.length < 2) return '<div class="spark-empty">Not enough recorded data yet</div>';
  const vals = series.map((s) => s.v);
  lo = lo ?? Math.min(...vals); hi = hi ?? Math.max(...vals);
  if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
  const W = 600, H = height, x = (t) => ((t - from) / (to - from)) * W, y = (v) => H - 4 - ((v - lo) / (hi - lo)) * (H - 8);
  let d = '', prev = null;
  for (const s of series) { d += `${!prev || s.t - prev.t > 20 * 60e3 ? 'M' : 'L'}${x(s.t).toFixed(1)},${y(s.v).toFixed(1)}`; prev = s; }
  const slices = 48, sw = W / slices;
  let hover = '';
  for (let i = 0; i < slices; i++) {
    const a = from + ((to - from) * i) / slices, b = from + ((to - from) * (i + 1)) / slices;
    const inside = series.filter((s) => s.t >= a && s.t < b);
    if (!inside.length) continue;
    const s = inside[inside.length - 1];
    hover += `<rect x="${(i * sw).toFixed(1)}" y="0" width="${sw.toFixed(1)}" height="${H}" fill="transparent" data-tip="${esc(`<b>${clockOf(s.t)}</b><br>${fmt(s.v)}`)}"/>`;
  }
  return `<div class="mini-line ${cls}" style="height:${H}px"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <path d="${d}" vector-effect="non-scaling-stroke"/>${hover}</svg>
      <span class="ml-hi">${fmt(hi)}</span><span class="ml-lo">${fmt(lo)}</span></div>`;
}

function diagDeviceLabel(d) {
  const dom = state.domain;
  if (d.ProductType === 'Controller') return { name: 'Heating hub', sub: 'Controller', ico: 'house' };
  if (d.ProductType === 'SmartPlug') {
    const plug = dom.SmartPlug?.find((p) => p.id === d.id);
    const room = plug && roomById(plug.RoomId);
    return { name: plug?.Name || 'Smart plug', sub: room ? `Smart plug in ${roomName(room)}` : 'Smart plug', ico: 'plug' };
  }
  const b = batteryDevices().find((x) => x.d.id === d.id);
  return { name: b?.room ? roomName(b.room) : 'Not in a room', sub: b?.kind || d.ProductType, ico: b?.room ? roomIcon(b.room) : 'heater' };
}

const SIG_LEVEL = { VeryGood: 'good', Good: 'good', Medium: 'warn', Poor: 'critical', Online: 'good' };

function sectionHead(id, ico, title, sub) {
  return `<h2 class="diag-title" id="${id}">${icon(ico)}${title}</h2>${sub ? `<p class="diag-sub">${sub}</p>` : ''}`;
}

function diagHealth() {
  const net = state.diag?.network;
  if (!net) return sectionHead('d-health', 'wifi', 'Hub health') + `<div class="diag-panel"><p class="muted">${state.diag?.error ? esc(state.diag.error) : 'Loading network details…'}</p></div>`;
  const st = net.Station || {}, hc = net.HealthCheckStats || {}, tcp = net.TcpStats_SinceBoot || {};
  const rssi = st.RSSI?.Current, q = wifiQuality(rssi);
  const up = hc.WifiTotalUptime, down = hc.WifiTotalDowntime;
  const tiles = [
    [q.level, 'wifi', rssi != null ? `${rssi} dBm` : '—', `Wi-Fi signal: ${q.label}`, st.RSSI ? `Ranged ${st.RSSI.Min} to ${st.RSSI.Max} dBm` : ''],
    ['good', 'clock', fmtDur(hc.WifiLastUptime), 'Connected for', 'Since the last Wi-Fi drop'],
    [up && down / (up + down) > 0.001 ? 'warn' : 'good', 'gauge', up ? `${((up / (up + down)) * 100).toFixed(2)}%` : '—', 'Time online', up ? `Offline ${fmtDur(down)} in ${fmtDur(up + down)}` : ''],
    [sys().CloudConnectionStatus === 'Connected' ? 'good' : 'critical', 'refresh-cw', esc(sys().CloudConnectionStatus || '—'), 'Cloud connection', 'Needed for the Wiser app away from home'],
  ];
  const counters = [
    ['Wi-Fi disconnections', hc.StationTransitionToDisconnected_Count, 'Times the hub dropped off your Wi-Fi'],
    ["Couldn't find the router", hc.WifiStateApNotFound_Count, 'Scans where your network wasn\'t visible. Usually a router restart or a weak signal'],
    ['Router refused connection', hc.WifiStateAuthFail_Count, 'Rejected logins, often while the router is starting up'],
    ['Signal lost mid-connection', hc.WifiStateLinkLoss_Count, 'The link faded out while connected'],
    ['Cloud connection drops', hc.CloudConnectionDrop_Count, 'Times the link to Drayton\'s servers dropped'],
    ['Automatic recoveries', (hc.ReconnectionFix_Count || 0) + (hc.HealthCheckStackRecovery_Count || 0), 'Times the hub fixed its own connection'],
  ];
  const checks = [
    ['Internet check', hc.ExternalPingFailed_Count, hc.ExternalPing_Count, `Pings to ${esc(hc.IPv4AddressPing || 'the internet')}`],
    ['Router check', hc.InternalPingFailed_Count, hc.InternalPing_Count, 'Pings to your router'],
    ['Name lookups', hc.DnsResolutionTestFailed_Count, hc.DnsResolutionTest_Count, 'DNS tests'],
    ['Data resent', tcp.SegmentRetransmissions_Count, tcp.SegmentsSent_Count, 'Network packets sent twice, since the hub restarted'],
  ];
  const rs = state.history.filter((p) => p.w != null && p.t >= Date.now() - 24 * 3600e3).map((p) => ({ t: p.t, v: p.w }));
  const dhcp = st.DhcpStatus || {};
  return sectionHead('d-health', 'wifi', 'Hub health', 'How reliably the hub stays on your Wi-Fi and reaches the internet. Counters are totals over the hub\'s whole life.') + `
    <div class="diag-tiles">${tiles.map(([lvl, ico, big, label, sub]) => `<div class="diag-tile ${lvl}">${icon(ico)}<div><b>${big}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}</div></div>`).join('')}</div>
    <div class="diag-grid two">
      <div class="diag-panel">
        <h3>Connection problems</h3>
        <dl class="kv">${counters.map(([k, v, tip]) => `<div data-tip="${esc(tip)}"><dt>${k}</dt><dd>${num(v)}</dd></div>`).join('')}</dl>
      </div>
      <div class="diag-panel">
        <h3>Health checks</h3>
        <dl class="kv">${checks.map(([k, bad, total, tip]) => `<div data-tip="${esc(tip)}"><dt>${k}</dt><dd>${num(bad)} of ${num(total)} failed <small>${pct1(bad || 0, total)}</small></dd></div>`).join('')}</dl>
        <h3 style="margin-top:16px">Wi-Fi signal, last 24 hours</h3>
        ${miniLine(rs, { from: Date.now() - 24 * 3600e3, to: Date.now(), fmt: (v) => `${Math.round(v)} dBm` })}
      </div>
    </div>
    <div class="diag-panel">
      <h3>Network</h3>
      <dl class="kv cols">
        <div><dt>Network</dt><dd>${esc(st.SSID || '—')}</dd></div>
        <div><dt>Wi-Fi channel</dt><dd>${esc(st.Channel ?? '—')}</dd></div>
        <div><dt>IP address</dt><dd>${esc(dhcp.IPv4Address || '—')}</dd></div>
        <div><dt>Router</dt><dd>${esc(dhcp.IPv4DefaultGateway || '—')}</dd></div>
        <div><dt>Hub name</dt><dd>${esc(st.MdnsHostname || '—')}</dd></div>
        <div><dt>MAC address</dt><dd>${esc((st.MacAddress || '').replace(/(..)(?!$)/g, '$1:'))}</dd></div>
      </dl>
    </div>`;
}

function diagMesh() {
  const dom = state.domain;
  const devices = dom.Device || [];
  const byNode = new Map(devices.map((d) => [d.NodeId, d]));
  const hubDev = devices.find((d) => d.ProductType === 'Controller');
  const groups = new Map(); // key -> {parent, children}
  const offline = [];
  const key = (nodeId) => (byNode.has(nodeId) ? `n${nodeId}` : `u${nodeId}`);
  for (const d of devices) {
    if (d === hubDev) continue;
    if (!d.DisplayedSignalStrength) { offline.push(d); continue; }
    const parent = d.ProductType === 'SmartPlug' || d.ParentNodeId == null ? 0 : d.ParentNodeId;
    const k = key(parent);
    if (!groups.has(k)) groups.set(k, { nodeId: parent, children: [] });
    groups.get(k).children.push(d);
  }
  const chip = (d) => {
    const l = diagDeviceLabel(d);
    const lvl = SIG_LEVEL[d.DisplayedSignalStrength] || 'critical';
    const rssi = d.ReceptionOfDevice?.Rssi ?? d.ReceptionOfController?.Rssi;
    return `<div class="mesh-chip ${lvl}" data-tip="${esc(`<b>${l.name}</b><br>${l.sub}<br>Signal ${SIGNAL[d.DisplayedSignalStrength] || d.DisplayedSignalStrength || 'none'}${rssi != null ? `, ${rssi} dBm` : ''}`)}">
      ${icon(l.ico)}<span><b>${esc(l.name)}</b><small>${esc(l.sub)}</small></span><i class="sig ${lvl}">${icon(signalIcon(d))}</i></div>`;
  };
  const kids = (nodeId) => groups.get(key(nodeId))?.children || [];
  const direct = kids(0);
  const relays = direct.filter((d) => d.ProductType === 'SmartPlug');
  const directEnd = direct.filter((d) => d.ProductType !== 'SmartPlug');
  const unknown = [...groups.values()].filter((g) => g.nodeId !== 0 && !byNode.has(g.nodeId));
  const branch = (label, children) => `<div class="mesh-branch">${label}<div class="mesh-kids">${children.length ? children.map(chip).join('') : '<span class="muted">No devices relay through this one</span>'}</div></div>`;
  const z = dom.Zigbee || {};
  return sectionHead('d-mesh', 'signal-high', 'Radio network', 'Valves and thermostats talk to the hub by radio, either directly or relayed through a smart plug. A device on a weak link is more likely to drop out.') + `
    <div class="diag-panel mesh">
      <div class="mesh-root">${icon('house')}<b>Heating hub</b><small>Radio channel ${esc(z.NetworkChannel ?? '—')}</small></div>
      <div class="mesh-tree">
        ${relays.map((r) => branch(`<div class="mesh-relay">${chip(r)}<span class="mesh-note">relays for ${kids(r.NodeId).length}</span></div>`, kids(r.NodeId))).join('')}
        ${directEnd.length ? branch('<div class="mesh-relay plain">Talking to the hub directly</div>', directEnd) : ''}
        ${unknown.map((g) => branch(`<div class="mesh-relay plain warn">${icon('circle-alert')}Relayed by a device the hub doesn't list (radio ID ${g.nodeId})</div>`, g.children)).join('')}
        ${offline.length ? branch(`<div class="mesh-relay plain critical">${icon('wifi-off')}Not connected</div>`, offline) : ''}
      </div>
      <p class="diag-foot">Radio module ${esc(z.ZigbeeModuleVersion || '—')}. The radio has reset itself ${num((z.NoSignalReset || 0) + (z.Error72Reset || 0))} times.</p>
    </div>`;
}

function diagEnergy() {
  const plugs = state.domain.SmartPlug || [];
  if (!plugs.length) return '';
  const price = state.settings?.pricePerKwh ?? 25;
  const from = Date.now() - 24 * 3600e3;
  const cards = plugs.map((p) => {
    const room = roomById(p.RoomId);
    const pts = state.history.filter((h) => h.t >= from && h.p?.[p.id]);
    const w = pts.map((h) => ({ t: h.t, v: h.p[p.id][0] }));
    const totals = pts.map((h) => h.p[p.id][1]).filter((v) => v != null);
    const used = totals.length >= 2 ? Math.max(0, totals[totals.length - 1] - totals[0]) : null;
    const span = pts.length >= 2 ? pts[pts.length - 1].t - pts[0].t : 0;
    return `<div class="diag-panel energy">
      <div class="energy-head">${icon(p.OutputState === 'On' ? 'plug-zap' : 'plug')}<div><b>${esc(p.Name)}</b><small>${room ? `In ${esc(roomName(room))}, ` : ''}${p.OutputState === 'On' ? 'on' : 'off'}</small></div></div>
      <dl class="kv">
        <div><dt>Using now</dt><dd>${num(p.InstantaneousDemand ?? 0)} W</dd></div>
        <div><dt>Used ${span >= 23 * 3600e3 ? 'in the last 24 hours' : span ? `in the last ${fmtHours(span)}` : 'recently'}</dt><dd>${used == null ? '—' : `${(used / 1000).toFixed(2)} kWh <small>about ${((used / 1000) * price).toFixed(0)}p</small>`}</dd></div>
        <div><dt>Total recorded by the plug</dt><dd>${p.CurrentSummationDelivered != null ? `${(p.CurrentSummationDelivered / 1000).toFixed(1)} kWh` : '—'}</dd></div>
      </dl>
      <h3>Power, last 24 hours</h3>
      ${miniLine(w, { from, to: Date.now(), fmt: (v) => `${Math.round(v)} W`, height: 56, lo: 0 })}
    </div>`;
  }).join('');
  return sectionHead('d-energy', 'zap', 'Plug energy', 'Power and energy measured by each smart plug. Costs are estimates at your unit price.') + `
    <label class="price">Unit price <input type="number" min="1" max="200" step="0.5" value="${price}" data-act="price" aria-label="Electricity price in pence per kWh"> p per kWh</label>
    <div class="diag-grid three">${cards}</div>`;
}

function diagBoiler() {
  const dom = state.domain;
  const bs = sys().BoilerSettings || {};
  const now = Date.now();
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const spans = historySpans(now - 7 * 86400e3);
  const recorded = spans.reduce((a, s) => a + s.dt, 0);

  // Per-day firing time for the last 7 days.
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const start = new Date(midnight); start.setDate(start.getDate() - i);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    let on = 0, cov = 0;
    for (const s of spans) if (s.p.t >= start && s.p.t < end) { cov += s.dt; if (s.p.h) on += s.dt; }
    days.push({ start, on, cov, today: i === 0 });
  }
  const today = days[6];
  const weekOn = days.reduce((a, d) => a + d.on, 0);
  const maxOn = Math.max(...days.map((d) => d.on), 3600e3);
  const bars = days.map((d) => {
    const partial = d.cov < (d.today ? now - midnight : 86400e3) * 0.9;
    const label = d.start.toLocaleDateString('en-GB', { weekday: 'short' });
    return `<div class="bar-col" data-tip="${esc(`<b>${d.start.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })}</b><br>Boiler fired for ${fmtHours(d.on)}${d.cov ? `<br>Recorded ${fmtHours(d.cov)} of the day` : '<br>Nothing recorded'}`)}">
      <span class="bar-val">${d.cov ? fmtHours(d.on).replace(' min', 'm').replace(' h ', 'h ') : ''}</span>
      <div class="bar ${partial ? 'partial' : ''}" style="height:${d.cov ? Math.max(2, (d.on / maxOn) * 100) : 0}%"></div>
      <span class="bar-label">${d.today ? 'Today' : label}</span></div>`;
  }).join('');

  // Boiler on/off strip for the last 24 hours.
  const from24 = now - 24 * 3600e3;
  const strip = historySpans(from24).filter((s) => s.p.h).map((s) => `<i style="left:${((s.p.t - from24) / 864e5) * 100}%;width:${(s.dt / 864e5) * 100}%" data-tip="${esc(`Firing from ${clockOf(s.p.t)}`)}"></i>`).join('');
  const covered = historySpans(from24).map((s) => `<u style="left:${((s.p.t - from24) / 864e5) * 100}%;width:${(s.dt / 864e5) * 100}%"></u>`).join('');

  // Which rooms call for heat most, and how quickly they warm up.
  const roomStats = rooms().map((r) => {
    let dem = 0, cov = 0, rise = 0, riseT = 0;
    let seg = null;
    for (const s of spans) {
      const v = s.p.r?.[r.id];
      if (!v) continue;
      cov += s.dt;
      if (v[2] > 0) dem += s.dt;
      const heating = v[2] > 0 && v[0] !== NO_READING;
      if (heating && !seg) seg = { t: s.p.t, temp: v[0] };
      if (!heating && seg) {
        const mins = (s.p.t - seg.t) / 60000, prevTemp = v[0];
        if (mins >= 20 && prevTemp !== NO_READING && prevTemp > seg.temp) { rise += prevTemp - seg.temp; riseT += mins; }
        seg = null;
      }
    }
    return { r, share: cov ? dem / cov : 0, cov, rate: riseT ? (rise / 10) / (riseT / 60) : null };
  }).filter((x) => x.cov);
  const byShare = [...roomStats].sort((a, b) => b.share - a.share);
  const maxShare = Math.max(...byShare.map((x) => x.share), 0.01);

  const CPH = { CPH_3: 3, CPH_6: 6, CPH_9: 9, CPH_12: 12 };
  return sectionHead('d-boiler', 'flame', 'Boiler', `Worked out from what this panel has recorded (${fmtHours(recorded)} so far). The numbers fill in as the server keeps running.`) + `
    <div class="diag-tiles">
      <div class="diag-tile ${dom.HeatingChannel?.[0]?.HeatingRelayState === 'On' ? 'warm' : ''}">${icon('flame')}<div><b>${dom.HeatingChannel?.[0]?.HeatingRelayState === 'On' ? 'Firing' : 'Idle'}</b><span>Boiler now</span><small>${dom.HeatingChannel?.[0]?.PercentageDemand ?? 0}% demand</small></div></div>
      <div class="diag-tile">${icon('clock')}<div><b>${fmtHours(today.on)}</b><span>Fired today</span><small>Since midnight</small></div></div>
      <div class="diag-tile">${icon('calendar-days')}<div><b>${fmtHours(weekOn)}</b><span>Fired this week</span><small>Last 7 days recorded</small></div></div>
      <div class="diag-tile">${icon('settings-2')}<div><b>${esc(bs.FuelType || '—')}</b><span>${bs.ControlType?.includes('Relay') ? 'On/off relay control' : esc(bs.ControlType || '')}</span><small>Up to ${CPH[bs.CycleRate] || '—'} starts an hour, ${bs.OnOffHysteresis != null ? fmtT(bs.OnOffHysteresis) : '—'} switching band</small></div></div>
    </div>
    <div class="diag-grid two">
      <div class="diag-panel">
        <h3>Firing time per day</h3>
        <div class="bars">${bars}</div>
        <p class="diag-foot">Lighter bars cover part of a day only, because the panel wasn't recording the whole time.</p>
      </div>
      <div class="diag-panel">
        <h3>Last 24 hours</h3>
        <div class="fire-strip">${covered}${strip}</div>
        <div class="fire-axis"><span>${clockOf(from24)}</span><span>${clockOf(from24 + 12 * 3600e3)}</span><span>Now</span></div>
        <div class="spark-key" style="margin-top:8px"><span><i class="blk"></i>Boiler firing</span><span><i class="rec"></i>Recorded</span></div>
        <h3 style="margin-top:18px">Rooms calling for heat most</h3>
        ${byShare.length ? `<div class="hbars">${byShare.map((x) => `<div class="hbar" data-tip="${esc(`${roomName(x.r)} asked for heat ${(x.share * 100).toFixed(0)}% of the recorded time`)}"><span>${esc(roomName(x.r))}</span><div><i style="width:${(x.share / maxShare) * 100}%"></i></div><b>${(x.share * 100).toFixed(0)}%</b></div>`).join('')}</div>` : '<p class="muted">Not enough recorded data yet.</p>'}
      </div>
    </div>
    <div class="diag-panel">
      <h3>How fast rooms warm up</h3>
      ${roomStats.some((x) => x.rate) ? `<div class="rate-list">${[...roomStats].filter((x) => x.rate).sort((a, b) => b.rate - a.rate).map((x) => `<div><span>${icon(roomIcon(x.r))}${esc(roomName(x.r))}</span><b>${x.rate.toFixed(1)}° per hour</b></div>`).join('')}</div>
        <p class="diag-foot">Average rise while the room was calling for heat for at least 20 minutes. Slow rooms may have a small radiator, a draught, or a valve that isn't opening fully.</p>`
        : '<p class="muted">Not enough heating periods recorded yet. This fills in after the heating has run for a while.</p>'}
    </div>`;
}

function diagTidy() {
  const dom = state.domain;
  const items = [];
  const used = new Set(dom.Room.map((r) => r.ScheduleId).filter(Boolean));
  const unused = (state.sched?.Heating || []).filter((s) => !used.has(s.id));
  for (const r of dom.Room.filter((x) => !x.ScheduleId)) {
    const match = unused.find((s) => s.Name.trim().toLowerCase() === roomName(r).toLowerCase());
    items.push(['warn', 'calendar-clock', `${esc(roomName(r))} has no schedule`, match
      ? `There's an unused schedule with the same name, “${esc(match.Name)}”. You could assign it to the room in the Wiser app.`
      : 'The room only follows manual settings. Add a schedule in the Wiser app if it should heat on a timetable.']);
  }
  if (unused.length) {
    items.push(['info', 'layers', `${unused.length} saved ${unused.length === 1 ? 'schedule is' : 'schedules are'} not used by any room`,
      `${unused.map((s) => `“${esc(s.Name)}”`).join(', ')}. These are usually left over from rooms that were renamed or removed. They do no harm.`]);
  }
  for (const b of batteryDevices().filter((x) => !x.room)) {
    items.push(['warn', 'heater', `A ${b.kind.toLowerCase()} isn't assigned to any room`, `${b.status.offline ? "It isn't reporting either, so it's " : "It's "}probably an old device still paired to the hub. Remove it in the Wiser app if you no longer use it. Serial ${esc(b.d.SerialNumber || '—')}.`]);
  }
  for (const b of batteryDevices().filter((x) => x.room && x.status.offline)) {
    items.push(['critical', 'wifi-off', `${esc(roomName(b.room))}: ${esc(b.kind.toLowerCase())} isn't reporting`, 'Try new batteries. If it still won\'t connect, it may be out of range of the hub and the smart plugs.']);
  }
  const nodes = new Set((dom.Device || []).map((d) => d.NodeId));
  const ghosts = [...new Set((dom.Device || []).map((d) => d.ParentNodeId).filter((n) => n != null && n !== 0 && !nodes.has(n)))];
  if (ghosts.length) {
    items.push(['info', 'signal-low', `${ghosts.length === 1 ? 'A device relays' : 'Some devices relay'} through radio ${ghosts.length === 1 ? 'ID' : 'IDs'} ${ghosts.join(', ')}, which the hub doesn't list`, 'Often a neighbour\'s device or a removed smart plug. The devices will find a new route if it disappears.']);
  }
  const rank = { critical: 0, warn: 1, info: 2 };
  items.sort((a, b) => rank[a[0]] - rank[b[0]]);
  return sectionHead('d-tidy', 'circle-alert', 'Tidy-up', 'Loose ends in the hub\'s setup.') + `
    <div class="diag-panel">${items.length ? `<ul class="tidy">${items.map(([lvl, ico, title, body]) => `<li class="${lvl}">${icon(ico)}<div><b>${title}</b><p>${body}</p></div></li>`).join('')}</ul>` : '<p class="muted">Nothing to tidy up.</p>'}</div>`;
}

function diagValves() {
  const dom = state.domain;
  const rows = batteryDevices().sort((a, b) => (a.room ? roomName(a.room) : '~').localeCompare(b.room ? roomName(b.room) : '~')).map((b) => {
    const { d, room } = b;
    const valve = d.ProductType === 'iTRV' ? dom.SmartValve?.find((v) => v.id === d.id) : null;
    const stat = d.ProductType === 'RoomStat' ? dom.RoomStat?.find((v) => v.id === d.id) : null;
    const own = valve?.MeasuredTemperature ?? stat?.MeasuredTemperature;
    const roomT = room ? roomTemp(room) : null;
    const ownOk = own != null && own !== NO_READING;
    // Only worth comparing when the room has several sensors; otherwise this device *is* the room reading.
    const sensors = room ? (room.SmartValveIds || []).length + (room.RoomStatId ? 1 : 0) : 0;
    const diff = ownOk && roomT != null && sensors > 1 ? own - roomT : null;
    return `<tr>
      <td><span class="cell-name">${icon(room ? roomIcon(room) : 'heater')}<span><b>${room ? esc(roomName(room)) : 'Not in a room'}</b><small>${esc(b.kind)}</small></span></span></td>
      <td>${ownOk ? fmtT(own) : '—'}</td>
      <td>${diff == null ? (sensors === 1 && ownOk ? '<span class="muted-cell" data-tip="The room\'s only sensor, so it sets the room temperature">Only sensor</span>' : '—') : `<span class="${Math.abs(diff) >= 15 ? 'warn-text' : ''}">${diff > 0 ? '+' : ''}${(diff / 10).toFixed(1)}°</span>`}</td>
      <td>${valve ? (valve.SetPoint != null ? fmtT(valve.SetPoint) : '—') : stat?.SetPoint != null ? fmtT(stat.SetPoint) : '—'}</td>
      <td>${valve?.PercentageDemand != null ? `${valve.PercentageDemand}%` : '—'}</td>
      <td>${stat?.MeasuredHumidity != null ? `${stat.MeasuredHumidity}% humidity` : valve?.WindowState ? (valve.WindowState === 'Open' ? '<span class="warn-text">Window open</span>' : 'Window closed') : '—'}</td>
      <td>${esc(d.ActiveFirmwareVersion || '—')}</td>
      <td><button class="switch" role="switch" aria-checked="${!!d.DeviceLockEnabled}" data-act="dev-lock" data-dev="${d.id}" data-on="${d.DeviceLockEnabled ? 0 : 1}" data-k="lock-${d.id}" ${d.DisplayedSignalStrength ? '' : 'disabled'} aria-label="Lock the buttons on this device"><span class="track"></span>${d.DeviceLockEnabled ? 'Locked' : 'Off'}</button></td>
    </tr>`;
  }).join('');
  const upg = dom.UpgradeInfo || [];
  return sectionHead('d-valves', 'heater', 'Valves and thermostats', 'Each device\'s own reading. In rooms with more than one sensor it\'s compared with the room temperature the hub uses. A valve reading well above the room is usually sitting close to the hot radiator.') + `
    <div class="diag-panel table-wrap">
      <table class="diag-table">
        <thead><tr><th>Device</th><th>Its reading</th><th>Versus room</th><th>Target</th><th>Valve open</th><th>Extra</th><th>Firmware</th><th>Button lock</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="diag-foot">The hub has ${upg.length} firmware ${upg.length === 1 ? 'file' : 'files'} ready to send to devices. It updates them automatically in the background.</p>
    </div>`;
}

function hubSettings() {
  const s = sys();
  const cap = state.pendingAwayCap ?? s.AwayModeSetPointLimit;
  const preheat = s.PreheatTimeLimit;
  const opts = [3600, 7200, 10800];
  if (preheat && !opts.includes(preheat)) opts.push(preheat);
  opts.sort((a, b) => a - b);
  const winRooms = rooms();
  return sectionHead('s-heating', 'heater', 'Heating system', 'Settings stored on the hub. These change it straight away.') + `
    <div class="diag-grid two">
      <div class="diag-panel">
        <div class="setting">
          <div><b>Away mode temperature</b><p>The most any room is heated to while away mode is on.</p></div>
          <div class="stepper ${state.pendingAwayCap != null ? 'pending' : ''}">
            <button data-act="away-cap" data-d="-5" data-k="cap-m" ${cap <= MIN_T ? 'disabled' : ''} aria-label="Lower">${icon('minus')}</button>
            <output>${fmtT(cap)}</output>
            <button data-act="away-cap" data-d="5" data-k="cap-p" ${cap >= 210 ? 'disabled' : ''} aria-label="Higher">${icon('plus')}</button>
          </div>
        </div>
        <div class="setting">
          <div><b>Valve protection</b><p>Moves every valve briefly once a week so they don't seize up over summer.</p></div>
          ${switchHTML('valve-protect', !!s.ValveProtectionEnabled, 'heater', s.ValveProtectionEnabled ? 'On' : 'Off', 'Exercise valves weekly')}
        </div>
        <div class="setting">
          <div><b>Comfort mode pre-heat limit</b><p>How early comfort mode may start heating so a room is warm by its scheduled time.${s.ComfortModeEnabled ? '' : ' Comfort mode is currently off.'}</p></div>
          <div class="seg" role="group" aria-label="Pre-heat limit">${opts.map((o) => `<button data-act="preheat" data-v="${o}" aria-pressed="${o === preheat}">${o / 3600} h</button>`).join('')}</div>
        </div>
      </div>
      <div class="diag-panel">
        <h3>Open-window detection</h3>
        <p class="diag-foot" style="margin:0 0 10px">Turns a room's heating off for a while when its temperature drops suddenly, as if a window was opened.</p>
        <div class="win-list">${winRooms.map((r) => `<div><span>${icon(roomIcon(r))}${esc(roomName(r))}</span>
          <button class="switch" role="switch" aria-checked="${!!r.WindowDetectionActive}" data-act="window-detect" data-room="${r.id}" data-on="${r.WindowDetectionActive ? 0 : 1}" data-k="win-${r.id}" aria-label="Open-window detection in ${esc(roomName(r))}"><span class="track"></span></button></div>`).join('')}</div>
      </div>
    </div>`;
}

function diagInfo() {
  const s = sys();
  const rise = s.SunriseTimes || [], set = s.SunsetTimes || [];
  const base = new Date(); base.setHours(0, 0, 0, 0);
  const sunRows = rise.slice(0, 7).map((r, i) => {
    const d = new Date(base); d.setDate(d.getDate() + i);
    const len = hhmm2min(set[i]) - hhmm2min(r);
    return `<tr><td>${i === 0 ? 'Today' : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</td><td>${hhmmStr(r)}</td><td>${set[i] != null ? hhmmStr(set[i]) : '—'}</td><td>${set[i] != null ? `${Math.floor(len / 60)} h ${len % 60} min` : '—'}</td></tr>`;
  }).join('');
  const z = state.domain.Zigbee || {};
  const tz = s.TimeZoneOffset ?? 0;
  return sectionHead('d-info', 'sun', 'Hub info') + `
    <div class="diag-grid two">
      <div class="diag-panel">
        <dl class="kv">
          <div><dt>Hub firmware</dt><dd>${esc(s.ActiveSystemVersion || '—')}</dd></div>
          <div><dt>Hardware</dt><dd>${esc(s.BrandName || 'Wiser')} hub, generation ${esc(s.HardwareGeneration ?? '—')}</dd></div>
          <div><dt>Radio module</dt><dd>${esc(z.ZigbeeModuleVersion || '—')}</dd></div>
          <div><dt>Cloud</dt><dd>${esc(s.CloudConnectionStatus || '—')}</dd></div>
          <div><dt>Time zone</dt><dd>UTC${tz >= 0 ? '+' : ''}${tz / 60 || 0}${s.AutomaticDaylightSaving ? ', clocks change automatically' : ''}</dd></div>
          <div><dt>Hub time</dt><dd>${esc(s.LocalDateAndTime?.Day || '')} ${s.LocalDateAndTime ? hhmmStr(s.LocalDateAndTime.Time) : ''}</dd></div>        </dl>
      </div>
      <div class="diag-panel">
        <h3>Sunrise and sunset</h3>
        ${sunRows ? `<table class="diag-table compact"><thead><tr><th>Day</th><th>Sunrise</th><th>Sunset</th><th>Daylight</th></tr></thead><tbody>${sunRows}</tbody></table>
        <p class="diag-foot">Worked out by the hub from its location.</p>` : '<p class="muted">The hub didn\'t provide sunrise times.</p>'}
      </div>
    </div>`;
}

function diagnosticsView() {
  if (!state.diag) { state.diag = {}; loadDiagnostics(); }
  return `<nav class="diag-nav" aria-label="Diagnostics sections">${DIAG_SECTIONS.map(([id, ico, label]) => `<a class="chip" href="#${id}">${icon(ico)}${label}</a>`).join('')}</nav>
    ${diagHealth()}${diagMesh()}${diagEnergy()}${diagBoiler()}${diagTidy()}${diagValves()}${diagInfo()}`;
}

// ---------------------------------------------------------------------------
// Signing in. Only needed once a password is set, or when other devices can reach the panel.

function lock(mode) {
  if (state.auth === mode) return;
  state.auth = mode;
  document.body.classList.add('locked');
  hideTip();
  closePopover();
  if ($('#modal').open) closeModal();
  if ($('#editor').open) $('#editor').close();
  $('#main').innerHTML = authView();
  $('#authPw')?.focus();
}

function unlock() {
  state.auth = null;
  document.body.classList.remove('locked');
  state.loading = !state.domain;
  boot();
}

function authView() {
  const title = esc($('#appTitle').textContent);
  if (state.auth === 'forbidden') {
    return `<div class="auth"><div class="auth-card">
      <div class="auth-flame">${icon('circle-alert')}</div>
      <h2>Open it on this computer</h2>
      <p>This panel only accepts visits from the computer it runs on. Open <b>http://localhost:${esc(location.port || 80)}</b> there. To use it from other devices, see Settings on that computer.</p>
    </div></div>`;
  }
  const setup = state.auth === 'setup';
  return `<div class="auth"><form class="auth-card" id="authForm">
    <div class="auth-flame">${icon('flame')}</div>
    <h2>${setup ? 'Create a password' : 'Sign in'}</h2>
    <p>${setup
      ? `Other devices on your network can open ${title}, so it needs a password. You'll use it to sign in on each device. You can change it later in Settings.`
      : `Enter the password for ${title}. You'll stay signed in on this device for 30 days.`}</p>
    <label class="field">Password<input type="password" id="authPw" autocomplete="${setup ? 'new-password' : 'current-password'}" required></label>
    ${setup ? '<label class="field">Type it again<input type="password" id="authPw2" autocomplete="new-password" required></label>' : ''}
    <p class="auth-error" id="authError" role="alert"></p>
    <button class="btn primary" type="submit">${icon(setup ? 'check' : 'lock')}${setup ? 'Create password' : 'Sign in'}</button>
  </form></div>`;
}

async function submitAuth() {
  const setup = state.auth === 'setup';
  const pw = $('#authPw').value, err = $('#authError'), btn = $('#authForm button[type="submit"]');
  if (setup && pw.length < 8) { err.textContent = 'Use at least 8 characters'; return; }
  if (setup && pw !== $('#authPw2').value) { err.textContent = "The two passwords don't match"; return; }
  err.textContent = '';
  btn.disabled = true;
  try {
    await api('POST', setup ? '/api/auth/setup' : '/api/login', { password: pw });
    unlock();
  } catch (e) {
    err.textContent = e.message;
    btn.disabled = false;
    $('#authPw').select();
  }
}

async function signOut() {
  try { await api('POST', '/api/logout'); } catch { /* signing out anyway */ }
  lock('login');
}

// Settings: who can open the panel, and its password.
function accessPanel(st) {
  if (st.homeAssistant) {
    return `<div class="setting"><div><b>Sign-in</b><p>Home Assistant takes care of this. Anyone who can sign in to your Home Assistant can open the panel from its sidebar.</p></div></div>
      <p class="diag-foot">Settings, history, layout and backups are kept in the app's own folder, so they're included in your Home Assistant backups.</p>`;
  }
  const pw = st.password, net = st.network;
  const status = pw.fromEnv ? 'Set by <code>PANEL_PASSWORD</code> when the server starts. Change it there.'
    : pw.set ? 'Everyone signs in with a password. Each device stays signed in for 30 days.'
    : net.exposed ? '<span class="warn-text">No password yet, so anyone on your network can open this panel. Set one now.</span>'
    : "No password. Only this computer can open the panel, so one isn't needed.";
  const buttons = [
    pw.fromEnv ? '' : `<button class="btn" data-act="pw-change">${icon('lock')}${pw.set ? 'Change password' : 'Set a password'}</button>`,
    pw.set && !pw.fromEnv && net.local ? `<button class="btn ghost danger" data-act="pw-remove">Remove</button>` : '',
    pw.set ? `<button class="btn ghost" data-act="sign-out">${icon('log-out')}Sign out</button>` : '',
  ].join('');
  // With no addresses from the server (as in Docker), the one this browser used is the best guide.
  const urls = net.urls.length ? net.urls : [location.origin];
  const devices = net.exposed
    ? `Other devices on your network can open the panel at ${urls.map((u) => `<code>${esc(u)}</code>`).join(' or ')}.`
    : 'Only this computer can open the panel. To use it from a phone or another computer, set a password, then set <code>"host": "0.0.0.0"</code> in config.json and restart the server.';
  return `<div class="setting">
      <div><b>Password</b><p>${status}</p></div>
      <div class="set-buttons">${buttons}</div>
    </div>
    <div class="setting"><div><b>Other devices</b><p>${devices}</p></div></div>
    <p class="diag-foot">Settings, history, layout and backups are kept in <code>${esc(net.dataDir)}</code>.</p>`;
}

function openPasswordModal(remove = false) {
  const pw = state.settings.password;
  const net = state.settings.network;
  openModal(`<div class="modal-body">
      <h2>${remove ? 'Remove the password' : pw.set ? 'Change password' : 'Set a password'}</h2>
      <p>${remove
        ? `This computer will open the panel without signing in.${net.exposed ? ' Other devices will be asked to create a new password.' : ''}`
        : `Use at least 8 characters. ${pw.set ? 'Other devices will need to sign in again.' : 'Every device, this one included, will sign in with it.'}`}</p>
      ${pw.set ? '<label class="field">Current password<input type="password" id="mPwCur" autocomplete="current-password"></label>' : ''}
      ${remove ? '' : `<label class="field">New password<input type="password" id="mPwNew" autocomplete="new-password"></label>
        <label class="field">Type it again<input type="password" id="mPwNew2" autocomplete="new-password"></label>`}
    </div>
    <div class="modal-foot">
      <button class="btn ghost" data-md="cancel">Cancel</button>
      <button class="btn ${remove ? 'danger-fill' : 'primary'}" data-md="save">${icon(remove ? 'trash' : 'check')}${remove ? 'Remove password' : 'Save password'}</button>
    </div>`, (act) => {
    if (act !== 'save') return;
    const next = remove ? '' : $('#mPwNew').value;
    if (!remove && next.length < 8) return toast('Use at least 8 characters', true);
    if (!remove && next !== $('#mPwNew2').value) return toast("The two passwords don't match", true);
    const current = $('#mPwCur')?.value || '';
    libAction(async () => { state.settings = await api('PUT', '/api/auth/password', { current, next }); }, remove ? 'Password removed' : 'Password saved');
  });
  $('#modal input[type="password"]')?.focus();
}

// ---------------------------------------------------------------------------
// "Find my hub": asks the server to look for Wiser hubs on the network, then fills in the address.

function findHubHTML() {
  const d = state.discover;
  const current = String(state.setDraft.hubIp ?? state.settings?.hubIp ?? '');
  const button = `<button class="btn small" data-act="find-hub" ${d?.busy ? 'disabled' : ''}>${icon('search')}${d?.busy ? 'Looking…' : 'Find my hub'}</button>`;
  let msg = '';
  if (d?.busy) {
    msg = '<span class="find-msg">Looking for your hub on the network. This can take up to 20 seconds.</span>';
  } else if (d?.error) {
    msg = `<span class="find-msg bad">${icon('circle-alert')}<span>${esc(d.error)}</span></span>`;
  } else if (d?.hubs?.length === 1) {
    const h = d.hubs[0];
    msg = `<span class="find-msg ok">${icon('check')}<span>Found ${h.name ? `<b>${esc(h.name)}</b> ` : 'your hub '}at <b>${esc(h.address)}</b>${current === h.address ? ', and filled it in.' : '.'}</span></span>
      ${current === h.address ? '' : `<button class="btn small" data-act="use-hub" data-ip="${esc(h.address)}">Use it</button>`}`;
  } else if (d?.hubs?.length > 1) {
    msg = `<span class="find-msg">Found ${d.hubs.length} hubs. Choose yours:</span>
      <span class="find-list">${d.hubs.map((h) => `<button class="btn small ${current === h.address ? 'primary' : ''}" data-act="use-hub" data-ip="${esc(h.address)}">${esc(h.name || 'Wiser hub')} <small>${esc(h.address)}</small></button>`).join('')}</span>`;
  } else if (d) {
    msg = `<span class="find-msg bad">${icon('circle-alert')}<span>${d.docker
      ? "The panel can't search your network from inside Docker. Please type the address instead."
      : "No hub found. Check it's switched on and on the same network as this panel, or type its address."}</span></span>`;
  }
  return `<div class="find-hub">${button}${msg}</div>`;
}

async function findHub() {
  state.discover = { busy: true };
  renderMain();
  try {
    state.discover = await api('GET', '/api/discover');
    // One hub: fill it in straight away.
    if (state.discover.hubs.length === 1) useHub(state.discover.hubs[0].address, false);
  } catch (e) {
    state.discover = { error: e.message };
  }
  renderMain();
}

function useHub(ip, render = true) {
  state.setDraft.hubIp = ip;
  state.setupError = '';
  state.setTest = null;
  if (render) renderMain();
}

// ---------------------------------------------------------------------------
// First-run setup: shown until a hub is connected. Welcome, hub address, hub secret, done.

const SETUP_STEPS = ['Welcome', 'Hub address', 'Hub secret', 'Done'];

function setupView() {
  const st = state.settings || {};
  const d = state.setDraft;
  const step = state.setupStep;
  const t = state.setTest;
  const progress = `<ol class="setup-steps" aria-label="Setup progress">${SETUP_STEPS.map((label, i) =>
    `<li class="${i < step ? 'done' : i === step ? 'on' : ''}" ${i === step ? 'aria-current="step"' : ''}><i>${i < step ? icon('check') : i + 1}</i><span>${label}</span></li>`).join('')}</ol>`;
  const back = `<button class="btn ghost" data-act="setup-back">${icon('chevron-left')}Back</button>`;
  let body;

  if (step === 0) {
    body = `<h2>Welcome</h2>
      <p>This panel shows your whole home's heating on one screen. Change schedules, boost rooms, and keep an eye on batteries. First it needs to connect to your Wiser hub, which takes a couple of minutes.</p>
      <label class="field">What would you like to call it?
        <input type="text" class="set-input" data-set="title" data-k="setup-title" maxlength="60" value="${esc(d.title ?? (st.title !== st.defaultTitle ? st.title : '') ?? '')}" placeholder="${esc(st.defaultTitle || 'For example, The Smiths\' Heating')}">
        <small>Shown at the top of the page. Leave it empty to use "${esc(st.defaultTitle || 'Wiser Heating')}". You can change it later in Settings.</small></label>
      <div class="setup-foot"><span></span><button class="btn primary" data-act="setup-next">Get started${icon('chevron-right')}</button></div>`;
  } else if (step === 1) {
    body = `<h2>Your hub's address</h2>
      <p>Your Wiser hub has an address on your home network, such as <code>192.168.1.50</code>. Press <b>Find my hub</b> to look for it. Or type it in: your router's list of connected devices shows it, named <b>WiserHeat</b> followed by letters and numbers.</p>
      <label class="field">Hub address
        <input type="text" class="set-input" data-set="hubIp" data-k="setup-hub" value="${esc(d.hubIp ?? st.hubIp ?? '')}" placeholder="192.168.1.50" spellcheck="false" autocomplete="off" autocapitalize="off"></label>
      ${findHubHTML()}
      <p class="setup-error" role="alert">${esc(state.setupError || '')}</p>
      <div class="setup-foot">${back}<button class="btn primary" data-act="setup-next">Next${icon('chevron-right')}</button></div>`;
  } else if (step === 2) {
    const result = t?.busy ? '<p class="set-result">Connecting to your hub…</p>'
      : t && !t.ok ? `<p class="set-result bad">${icon('circle-alert')}${esc(t.msg)}</p>` : '';
    body = `<h2>Your hub's secret</h2>
      <p>The secret is a long code that lets this panel control your hub. You only need to copy it once.</p>
      <ol class="setup-howto">
        <li>Press the setup button on the hub once. Its light starts flashing.</li>
        <li>Join the Wi-Fi network the hub creates, called <b>WiserHeat</b> followed by letters and numbers. You can do this on this device; this page will wait.</li>
        <li>Open <code>http://192.168.8.1/secret</code> in a new browser tab, and copy all the text.</li>
        <li>Press the setup button on the hub again, and go back to your usual Wi-Fi.</li>
      </ol>
      <label class="field">Hub secret
        <textarea class="set-input set-secret" rows="3" data-set="secret" data-k="setup-secret" placeholder="Paste the secret here" spellcheck="false" autocomplete="off" autocapitalize="off">${esc(d.secret ?? '')}</textarea></label>
      ${result}
      <div class="setup-foot">${back}<button class="btn primary" data-act="setup-connect" ${t?.busy ? 'disabled' : ''}>${icon('refresh-cw')}Connect</button></div>`;
  } else {
    const found = t?.found || {};
    const names = found.names || [];
    body = `<div class="setup-done">${icon('check')}</div>
      <h2>Connected</h2>
      <p>Found ${found.rooms ?? names.length} ${found.rooms === 1 ? 'room' : 'rooms'} on your hub${found.firmware ? ` (firmware ${esc(found.firmware)})` : ''}.</p>
      ${names.length ? `<ul class="setup-rooms">${names.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      <p>Everything here can be changed later in Settings, under the cog at the top of the page.</p>
      <div class="setup-foot"><span></span><button class="btn primary" data-act="setup-finish">Open my heating${icon('chevron-right')}</button></div>`;
  }
  return `<div class="setup"><div class="setup-card">${progress}${body}</div></div>`;
}

function setupGo(step) {
  state.setupStep = step;
  state.setupError = '';
  if (step !== 3) state.setTest = null;
  renderMain();
  $('.setup-card input, .setup-card textarea')?.focus();
}

function setupNext() {
  if (state.setupStep === 1) {
    const ip = String(state.setDraft.hubIp ?? state.settings?.hubIp ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(ip)) {
      state.setupError = ip ? "That doesn't look like an address. It should look something like 192.168.1.50." : "Enter your hub's address to carry on.";
      renderMain();
      $('.setup-card input')?.focus();
      return;
    }
    state.setDraft.hubIp = ip;
  }
  setupGo(state.setupStep + 1);
}

async function setupConnect() {
  if (!String(state.setDraft.secret ?? '').replace(/\s+/g, '')) {
    state.setTest = { ok: false, msg: 'Paste the secret from your hub first.' };
    renderMain();
    return;
  }
  if (!(await testHubConnection())) return;
  const title = String(state.setDraft.title ?? '').trim();
  await saveSettings({ ...hubDraft(), ...(title ? { title } : {}) });
  if (hubConfigured()) setupGo(3);
}

async function setupFinish() {
  state.setupStep = null;
  state.setTest = null;
  state.view = 'schedules';
  store.set('view', state.view);
  state.loading = true;
  renderAll();
  await refresh();
  loadHistory();
}

// ---------------------------------------------------------------------------
// Settings page (the cog in the header). The server saves these in config.json.

const SETTINGS_SECTIONS = [
  ['s-panel', 'house', 'This panel'],
  ['s-icons', 'sofa', 'Room icons'],
  ['s-hub', 'wifi', 'Hub connection'],
  ['s-access', 'lock', 'Sign-in and access'],
  ['s-phone', 'smartphone', 'Add to your phone'],
  ['s-rec', 'clock', 'Recording'],
  ['s-heating', 'heater', 'Heating system'],
];
const INTERVALS = [[60, '1 min'], [120, '2 min'], [300, '5 min'], [600, '10 min']];
const KEEPS = [[24, '1 day'], [72, '3 days'], [168, '7 days'], [336, '14 days'], [720, '30 days']];

function choiceSeg(key, opts, cur, label, unit) {
  if (cur != null && !opts.some(([v]) => v === cur)) opts = [...opts, [cur, `${cur} ${unit}`]].sort((a, b) => a[0] - b[0]);
  return `<div class="seg" role="group" aria-label="${label}">${opts.map(([v, l]) => `<button data-act="set-choice" data-key="${key}" data-v="${v}" aria-pressed="${v === cur}">${l}</button>`).join('')}</div>`;
}

function settingsView() {
  const st = state.settings;
  if (!st) return `<div class="loading">${icon('settings')}<p>Loading settings…</p></div>`;
  const d = state.setDraft;
  const val = (k) => esc(d[k] ?? st[k] ?? '');
  const theme = store.get('theme', null) || 'system';
  const t = state.setTest;
  const result = t?.busy ? '<span class="set-result">Testing…</span>'
    : t ? `<span class="set-result ${t.ok ? 'ok' : 'bad'}">${icon(t.ok ? 'check' : 'circle-alert')}${esc(t.msg)}</span>` : '';
  const heating = state.domain
    ? hubSettings()
    : sectionHead('s-heating', 'heater', 'Heating system', 'Settings stored on the hub.') + '<div class="diag-panel"><p class="muted">Connect to the hub to change these.</p></div>';

  return `<div class="settings-page">
    <h2 class="page-title">${icon('settings')}Settings</h2>
    <nav class="diag-nav" aria-label="Settings sections">${SETTINGS_SECTIONS.map(([id, ico, label]) => `<a class="chip" href="#${id}">${icon(ico)}${label}</a>`).join('')}</nav>

    ${sectionHead('s-panel', 'house', 'This panel', 'Saved on this computer, in config.json.')}
    <div class="diag-panel">
      <div class="setting">
        <div><b>Title</b><p>Shown at the top of the page and in the browser tab.</p></div>
        <input type="text" class="set-input" data-set="title" data-k="set-title" maxlength="60" value="${val('title')}" aria-label="Title">
      </div>
      <div class="setting">
        <div><b>Appearance</b><p>Light, dark, or the same as your computer. The button next to the cog switches it too. This browser remembers the choice.</p></div>
        <div class="seg" role="group" aria-label="Appearance">${[['system', 'Follow computer'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => `<button data-act="theme-set" data-v="${k}" aria-pressed="${theme === k}">${l}</button>`).join('')}</div>
      </div>
      <div class="setting">
        <div><b>Electricity price</b><p>Used for the smart plug cost estimates in Diagnostics.</p></div>
        <label class="price set-price"><input type="number" min="1" max="999" step="0.5" data-set="pricePerKwh" data-k="set-price" value="${val('pricePerKwh')}" aria-label="Electricity price in pence per kWh"> p per kWh</label>
      </div>
      ${st.homeAssistant ? '' : `<p class="diag-foot">The panel is running at port ${esc(st.port)}. To change the port, edit <code>port</code> in config.json and restart the server.</p>`}
    </div>

    ${sectionHead('s-icons', 'sofa', 'Room icons', "The hub doesn't store a picture for each room, so the panel guesses one from the room's name. Click a room to choose its icon yourself.")}
    <div class="diag-panel">${roomIconsPanel()}</div>

    ${sectionHead('s-hub', 'wifi', 'Hub connection', "How this panel reaches your Wiser hub. The secret is saved in config.json on this computer, and isn't shown again once saved.")}
    <div class="diag-panel">
      <div class="setting">
        <div><b>Hub address</b><p>The hub's IP address on your home network, for example 192.168.1.50. Press <b>Find my hub</b> to look for it, or check your router's list of connected devices for one named WiserHeat followed by letters and numbers.</p>
          ${findHubHTML()}</div>
        <input type="text" class="set-input" data-set="hubIp" data-k="set-hub" value="${val('hubIp')}" placeholder="192.168.1.50" spellcheck="false" autocomplete="off" aria-label="Hub address">
      </div>
      <div class="setting stacked">
        <div><b>Hub secret</b><p>A long code that lets the panel control the hub. To find it, press the setup button on the hub once so its light flashes, and join the WiserHeat Wi-Fi network it creates. Then open <code>http://192.168.8.1/secret</code> and copy the text. Press the setup button again to finish.${st.hasSecret ? ' A secret is already saved. Leave this empty to keep it.' : ''}</p></div>
        <textarea class="set-input set-secret" rows="2" data-set="secret" data-k="set-secret" placeholder="${st.hasSecret ? 'Saved. Paste a new secret here to replace it' : 'Paste the secret here'}" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="Hub secret">${esc(d.secret ?? '')}</textarea>
      </div>
      <div class="set-actions">
        ${result}
        <button class="btn" data-act="set-test" ${t?.busy ? 'disabled' : ''}>${icon('refresh-cw')}Test connection</button>
        <button class="btn primary" data-act="set-save-hub" ${t?.busy ? 'disabled' : ''}>${icon('save')}Save connection</button>
      </div>
    </div>

    ${sectionHead('s-access', 'lock', 'Sign-in and access', 'Who can open this panel.')}
    <div class="diag-panel">${accessPanel(st)}</div>

    ${sectionHead('s-phone', 'smartphone', 'Add to your phone', 'Put the panel on your home screen, with its own icon, so it opens like an app straight to Rooms.')}
    <div class="diag-panel">${phonePanel(st)}</div>

    ${sectionHead('s-rec', 'clock', 'Recording', "The hub doesn't keep any history, so this panel records temperatures while it's running. The graphs and boiler statistics come from these recordings.")}
    <div class="diag-panel">
      <div class="setting">
        <div><b>Record every</b><p>Recording more often gives smoother graphs, but a bigger history file.</p></div>
        ${choiceSeg('historyIntervalSeconds', INTERVALS, st.historyIntervalSeconds, 'Record every', 's')}
      </div>
      <div class="setting">
        <div><b>Keep recordings for</b><p>Older readings are deleted. The graphs show up to the last 7 days.</p></div>
        ${choiceSeg('historyKeepHours', KEEPS, st.historyKeepHours, 'Keep recordings for', 'h')}
      </div>
    </div>

    ${heating}
    <p class="settings-version">WiserHeat Control Panel ${esc(st.version || '')} · <a href="https://github.com/BayMax1990/WiserHeat-ControlPanel" target="_blank" rel="noopener">Project page and help</a></p>
  </div>`;
}

function roomIconsPanel() {
  if (!state.domain) return '<p class="muted">Connect to the hub to see your rooms.</p>';
  const chosen = state.settings.roomIcons || {};
  const { loose, groups } = roomGroups();
  return `<div class="icon-rooms">${[...loose, ...groups.flatMap((g) => g.list)].map((r) => `<button class="icon-room" data-act="pick-icon" data-room="${r.id}" data-k="icon-${r.id}">
      <span class="room-ico">${icon(roomIcon(r))}</span>
      <span><b>${esc(roomName(r))}</b><small>${chosen[r.id] ? 'Chosen by you' : 'Automatic, from the name'}</small></span>
    </button>`).join('')}</div>`;
}

function openIconPicker(roomId) {
  const r = roomById(roomId);
  const cur = state.settings?.roomIcons?.[r.id] || '';
  const choice = (name, label, ico = name) => `<button class="icon-choice" data-md="icon" data-v="${name}" aria-pressed="${cur === name}">${icon(ico)}<span>${label}</span></button>`;
  openModal(`<div class="modal-body">
      <h2>Icon for ${esc(roomName(r))}</h2>
      <p>Shown on the Schedules and Rooms tabs, and in Batteries and Diagnostics.</p>
      <div class="icon-grid">${choice('', 'Automatic', guessRoomIcon(r.Name))}${ROOM_ICONS.map(([n, l]) => choice(n, l)).join('')}</div>
    </div>
    <div class="modal-foot"><button class="btn ghost" data-md="cancel">Cancel</button></div>`, (act, el) => {
    if (act !== 'icon') return;
    closeModal();
    saveSettings({ roomIcons: { [r.id]: el.dataset.v || null } }, `Icon updated for ${roomName(r)}`);
  });
}

async function saveSettings(partial, okMsg) {
  try {
    state.settings = await api('PUT', '/api/settings', partial);
    for (const k of Object.keys(partial)) delete state.setDraft[k];
    applyTitle();
    if (okMsg) toast(okMsg);
  } catch (e) {
    toast(e.message, true);
  }
  renderHeader();
  renderBanner();
  renderMain();
}

// The address and secret as typed. A blank secret means "keep the saved one".
function hubDraft() {
  const body = { hubIp: String(state.setDraft.hubIp ?? state.settings.hubIp ?? '').trim() };
  const secret = String(state.setDraft.secret ?? '').replace(/\s+/g, '');
  if (secret) body.secret = secret;
  return body;
}

async function testHubConnection() {
  state.setTest = { busy: true };
  renderMain();
  try {
    const r = await api('POST', '/api/settings/test', hubDraft());
    state.setTest = { ok: true, found: r, msg: `Connected. The hub has ${r.rooms} ${r.rooms === 1 ? 'room' : 'rooms'}${r.firmware ? `, firmware ${r.firmware}` : ''}.` };
  } catch (e) {
    state.setTest = { ok: false, msg: e.message };
  }
  renderMain();
  return state.setTest.ok;
}

async function saveHubConnection() {
  const body = hubDraft();
  if (!body.hubIp) return toast('Enter the hub address', true);
  if (!body.secret && !state.settings.hasSecret) return toast('Paste the hub secret', true);
  const firstTime = !hubConfigured();
  if (!(await testHubConnection()) && !confirm(`${state.setTest.msg}\n\nSave these details anyway?`)) return;
  await saveSettings(body, 'Hub connection saved');
  state.loading = !state.domain;
  await refresh();
  if (firstTime && state.domain) { state.view = 'schedules'; store.set('view', state.view); renderAll(); }
}

function setTheme(v) {
  if (v === 'light' || v === 'dark') {
    document.documentElement.dataset.theme = v;
    store.set('theme', v);
  } else {
    delete document.documentElement.dataset.theme;
    try { localStorage.removeItem('wiser.theme'); } catch { /* ignore */ }
  }
  updateThemeBtn();
}

// ---------------------------------------------------------------------------
// Room actions

const pendingTimers = new Map();
function nudgeRoomTemp(r, d) {
  const cur = state.pendingTemps.get(r.id) ?? r.CurrentSetPoint;
  let next;
  if (cur === OFF) next = d > 0 ? MIN_T : OFF;
  else next = cur + d < MIN_T ? OFF : clamp(round05(cur + d), MIN_T, MAX_T);
  state.pendingTemps.set(r.id, next);
  renderMain();
  clearTimeout(pendingTimers.get(r.id));
  pendingTimers.set(r.id, setTimeout(async () => {
    await act(() => api('PATCH', `/api/room/${r.id}`, { RequestOverride: { Type: 'Manual', SetPoint: next, Originator: 'App' } }),
      `${roomName(r)} set to ${fmtT(next)}`);
    if (state.pendingTemps.get(r.id) === next) { state.pendingTemps.delete(r.id); renderMain(); }
  }, 900));
}

async function setRoomMode(r, mode) {
  const name = roomName(r);
  if (mode === 'auto') return act(() => api('PATCH', `/api/room/${r.id}`, { Mode: 'Auto' }), `${name} is following its schedule`);
  if (mode === 'off') {
    return act(async () => {
      await api('PATCH', `/api/room/${r.id}`, { Mode: 'Manual' });
      await api('PATCH', `/api/room/${r.id}`, { RequestOverride: { Type: 'Manual', SetPoint: OFF, Originator: 'App' } });
    }, `${name} turned off`);
  }
  const keep = r.CurrentSetPoint > MIN_T ? r.CurrentSetPoint : (r.ScheduledSetPoint > MIN_T ? r.ScheduledSetPoint : 200);
  return act(async () => {
    await api('PATCH', `/api/room/${r.id}`, { Mode: 'Manual' });
    await api('PATCH', `/api/room/${r.id}`, { RequestOverride: { Type: 'Manual', SetPoint: keep, Originator: 'App' } });
  }, `${name} held at ${fmtT(keep)}`);
}

function boostTarget(r, amount) {
  const base = roomTemp(r) ?? (r.CurrentSetPoint > MIN_T ? r.CurrentSetPoint : 180);
  return clamp(round05(base + amount), MIN_T, MAX_T);
}

async function boostRooms(list, amount, minutes) {
  const dur = minutes >= 60 ? `${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}` : `${minutes} minutes`;
  const msg = list.length === 1 ? `${roomName(list[0])} boosted to ${fmtT(boostTarget(list[0], amount))} for ${dur}` : `${list.length} rooms boosted for ${dur}`;
  await act(async () => {
    for (const r of list) {
      await api('PATCH', `/api/room/${r.id}`, { RequestOverride: { Type: 'Manual', DurationMinutes: minutes, SetPoint: boostTarget(r, amount), Originator: 'App' } });
    }
  }, msg);
}

const CANCEL = { RequestOverride: { Type: 'None', DurationMinutes: 0, SetPoint: 0, Originator: 'App' } };
async function cancelOverrides(list) {
  await act(async () => { for (const r of list) await api('PATCH', `/api/room/${r.id}`, CANCEL); },
    list.length === 1 ? `${roomName(list[0])} is back on its schedule` : 'All boosts cancelled');
}

async function setAway(on) {
  const limit = sys().AwayModeSetPointLimit ?? 70;
  const attempt = async (type) => {
    try { await api('PATCH', '/api/system', { RequestOverride: { Type: type, SetPoint: on ? limit : 0 } }); } catch { return false; }
    await settle();
    await refresh();
    return isAway() === on;
  };
  try {
    // Hubs accept the enum by name on most firmware; fall back to its number.
    if (await attempt(on ? 'Away' : 'None') || await attempt(on ? 2 : 0)) toast(on ? 'Away mode on' : 'Away mode off, rooms are back on their schedules');
    else toast("The hub didn't change away mode. Try again, or use the Wiser app.", true);
  } catch (e) { toast(e.message, true); await refresh(); }
}

// ---------------------------------------------------------------------------
// Boost popover

const boostPrefs = { amount: store.get('boostAmount', 20), minutes: store.get('boostMinutes', 60) };

function openBoost(anchor, roomId) {
  const pop = $('#popover');
  const all = roomId === 'all';
  const r = all ? null : roomById(roomId);
  const draw = () => {
    const durTxt = boostPrefs.minutes >= 60 ? `${boostPrefs.minutes / 60} h` : `${boostPrefs.minutes} min`;
    pop.innerHTML = `<h3>${icon('flame')}${all ? 'Boost every room' : `Boost ${esc(roomName(r))}`}</h3>
      <div class="row"><span>Warmer by</span><div class="seg">${[10, 20, 30].map((a) => `<button data-b="amount" data-v="${a}" aria-pressed="${boostPrefs.amount === a}">+${a / 10}°</button>`).join('')}</div></div>
      <div class="row"><span>For</span><div class="seg">${[30, 60, 120, 180].map((m) => `<button data-b="minutes" data-v="${m}" aria-pressed="${boostPrefs.minutes === m}">${m >= 60 ? m / 60 + ' h' : m + ' min'}</button>`).join('')}</div></div>
      <button class="btn warm" data-b="go">${icon('flame')}${all ? `Boost all +${boostPrefs.amount / 10}° for ${durTxt}` : `Boost to ${fmtT(boostTarget(r, boostPrefs.amount))} for ${durTxt}`}</button>`;
  };
  draw();
  pop.hidden = false;
  const a = anchor.getBoundingClientRect();
  const left = clamp(a.right - 280, 12, innerWidth - 292);
  const top = a.bottom + 8 + 240 > innerHeight ? a.top - 8 - pop.offsetHeight : a.bottom + 8;
  pop.style.left = `${left}px`;
  pop.style.top = `${Math.max(12, top)}px`;
  pop.onclick = (e) => {
    const b = e.target.closest('[data-b]');
    if (!b) return;
    if (b.dataset.b === 'go') {
      closePopover();
      boostRooms(all ? state.domain.Room.filter((x) => x.CalculatedTemperature !== NO_READING) : [r], boostPrefs.amount, boostPrefs.minutes);
      return;
    }
    boostPrefs[b.dataset.b] = Number(b.dataset.v);
    store.set(b.dataset.b === 'amount' ? 'boostAmount' : 'boostMinutes', boostPrefs[b.dataset.b]);
    draw();
  };
  $('[data-b="go"]', pop)?.focus();
}
function setDialogHTML(dlg, html) {
  const keep = [$('#toasts'), $('#tooltip')].filter((el) => el && el.parentNode === dlg);
  dlg.innerHTML = html;
  for (const el of keep) dlg.append(el);
}

// Boost a hand-picked set of rooms (Rooms page header).
function openBoostPicker() {
  const picked = new Set();
  const list = rooms();
  const durTxt = (m) => (m >= 60 ? `${m / 60} ${m === 60 ? 'hour' : 'hours'}` : `${m} minutes`);
  const footLabel = () => (picked.size
    ? `${icon('flame')}Boost ${picked.size} ${picked.size === 1 ? 'room' : 'rooms'} for ${durTxt(boostPrefs.minutes)}`
    : `${icon('flame')}Tick rooms to boost`);
  const body = () => `<div class="modal-body">
      <h2 class="boost-title">${icon('flame')}Boost rooms</h2>
      <p>Tick the rooms to warm up. Each one is boosted from its current temperature, then goes back to normal when the time is up.</p>
      <div class="boost-opts">
        <div><span>Warmer by</span><div class="seg">${[10, 20, 30].map((a) => `<button data-md="amount" data-v="${a}" aria-pressed="${boostPrefs.amount === a}">+${a / 10}°</button>`).join('')}</div></div>
        <div><span>For</span><div class="seg">${[30, 60, 120, 180].map((m) => `<button data-md="minutes" data-v="${m}" aria-pressed="${boostPrefs.minutes === m}">${m >= 60 ? m / 60 + ' h' : m + ' min'}</button>`).join('')}</div></div>
      </div>
      <div class="field">Rooms <span class="chip-links inline"><button data-md="all">All rooms</button><button data-md="none">None</button></span></div>
      <div class="room-pick">${list.map((r) => {
        const t = roomTemp(r);
        const ov = overrideInfo(r);
        return `<label class="pick"><input type="checkbox" value="${r.id}" ${picked.has(r.id) ? 'checked' : ''}>${icon(roomIcon(r))}
          <span><b>${esc(roomName(r))}</b><small>${t == null ? 'No reading' : fmtT(t)} now, boost to ${fmtT(boostTarget(r, boostPrefs.amount))}${ov?.boost ? `. Already boosted until ${ov.until}` : ''}</small></span></label>`;
      }).join('')}</div>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" data-md="cancel">Cancel</button>
      <button class="btn warm" data-md="go" id="boostGo" ${picked.size ? '' : 'disabled'}>${footLabel()}</button>
    </div>`;
  const redraw = (focusSel) => {
    setDialogHTML($('#modal'), body());
    if (focusSel) $(focusSel, $('#modal'))?.focus();
  };
  openModal(body(), (act, el) => {
    if (act === 'pick') {
      picked.clear();
      for (const id of pickedRooms()) picked.add(id);
      const go = $('#boostGo');
      go.disabled = !picked.size;
      go.innerHTML = footLabel();
      return;
    }
    if (act === 'amount' || act === 'minutes') {
      boostPrefs[act] = Number(el.dataset.v);
      store.set(act === 'amount' ? 'boostAmount' : 'boostMinutes', boostPrefs[act]);
      return redraw(`[data-md="${act}"][data-v="${el.dataset.v}"]`);
    }
    if (act === 'all') { for (const r of list) picked.add(r.id); return redraw('[data-md="all"]'); }
    if (act === 'none') { picked.clear(); return redraw('[data-md="none"]'); }
    if (act === 'go' && picked.size) {
      const chosen = list.filter((r) => picked.has(r.id));
      closeModal();
      boostRooms(chosen, boostPrefs.amount, boostPrefs.minutes);
    }
  });
}

function closePopover() { $('#popover').hidden = true; }

// ---------------------------------------------------------------------------
// Schedule editor sheet

// Opened from a room (roomId set) or straight from the schedule library (roomId null).
function openEditor(roomId, day, applyRooms) {
  const r = roomById(roomId);
  const s = schedFor(r);
  if (!s) return;
  openEditorFor(s.id, day, r.id, applyRooms || [r.id]);
}

function openEditorFor(schedId, day, roomId = null, applyRooms = []) {
  const days = daysOf(schedId);
  editor = {
    schedId,
    roomId,
    day,
    points: toPoints(days[day]),
    applyDays: new Set([day]),
    applyRooms: new Set(applyRooms),
    dirty: false,
    lastC: 180,
  };
  renderEditor();
  const dlg = $('#editor');
  if (!dlg.open) dlg.showModal();
}

function editorCarry() {
  return carryInto(daysOf(editor.schedId), editor.day);
}

// Schedule IDs an Apply will change: the one being edited, plus those of any extra rooms picked.
function editorTargets() {
  const ids = new Set([editor.schedId]);
  if (editor.roomId) for (const id of editor.applyRooms) { const x = roomById(id); if (x?.ScheduleId) ids.add(x.ScheduleId); }
  return ids;
}

function bigBandHTML() {
  return bandInner(editor.points, editorCarry(), { minLabel: 5 });
}

function renderEditor() {
  const dlg = $('#editor');
  const k = document.activeElement?.dataset?.k;
  const r = editor.roomId ? roomById(editor.roomId) : null;
  const sched = origSched(editor.schedId);
  const days = daysOf(editor.schedId);
  const carry = editorCarry();
  const schedRooms = rooms().filter((x) => schedFor(x));
  const sharing = schedRooms.filter((x) => x.ScheduleId === editor.schedId);
  const targets = editorTargets();
  const affected = schedRooms.filter((x) => targets.has(x.ScheduleId));
  const nRooms = affected.length, nDays = editor.applyDays.size;
  const title = r ? roomName(r) : sched?.Name || 'Schedule';

  const mini = DAYS.map((d) => {
    const pts = d === editor.day ? editor.points : toPoints(days[d]);
    const segs = segmentsFor(pts, carryInto(days, d)).map((s) => `<i class="${s.c === OFF ? 'off' : ''}" style="left:${(s.from / 1440) * 100}%;width:${((s.to - s.from) / 1440) * 100}%;${s.c === OFF || s.c == null ? '' : `background:${heat(s.c)}`}"></i>`).join('');
    return `<button data-ed="day" data-day="${d}" aria-current="${d === editor.day}" data-k="ed-day-${d}"><span class="d">${SHORT[d]}</span><div class="mini">${segs}</div></button>`;
  }).join('');

  const handles = editor.points.map((p, i) => `<button class="handle" data-i="${i}" style="left:calc(8px + (100% - 16px) * ${p.m / 1440})" aria-label="Change at ${fmtMin(p.m)}. Use arrow keys to move." data-k="h-${i}"><span class="tag">${fmtMin(p.m)}</span><span class="bar"></span></button>`).join('');

  const pointRows = editor.points.map((p, i) => `<div class="point">
      <span class="swatch ${p.c === OFF ? 'off' : ''}" style="${p.c === OFF ? 'background:repeating-linear-gradient(135deg,var(--hatch) 0 2px,transparent 2px 5px)' : `background:${heat(p.c)}`}"></span>
      <input type="time" value="${fmtMin(p.m)}" step="300" data-ed="time" data-i="${i}" data-k="t-${i}" aria-label="Time of change ${i + 1}">
      <div class="stepper">
        <button data-ed="temp" data-i="${i}" data-d="-5" data-k="tm-${i}" ${p.c === OFF ? 'disabled' : ''} aria-label="Cooler">${icon('minus')}</button>
        <output>${fmtT(p.c)}</output>
        <button data-ed="temp" data-i="${i}" data-d="5" data-k="tp-${i}" ${p.c >= MAX_T ? 'disabled' : ''} aria-label="Warmer">${icon('plus')}</button>
      </div>
      <button class="switch off-toggle" role="switch" aria-checked="${p.c === OFF}" data-ed="off" data-i="${i}" data-k="off-${i}"><span class="track"></span>Off</button>
      <span></span>
      <button class="icon-btn" data-ed="remove" data-i="${i}" aria-label="Remove the change at ${fmtMin(p.m)}">${icon('trash')}</button>
    </div>`).join('');

  const carryRow = editor.points.length && editor.points[0].m === 0 ? '' : `<div class="point carry">
      <span class="swatch ${carry?.c === OFF ? 'off' : ''}" style="${carry && carry.c !== OFF ? `background:${heat(carry.c)}` : ''}"></span>
      <span>${carry ? `From midnight it stays at ${fmtT(carry.c)}, carried over from ${carry.from === editor.day ? 'the last change of the week' : carry.from}.` : 'No temperature is set before the first change.'}</span>
    </div>`;

  const copyOpts = `<optgroup label="Other schedules on ${editor.day}">${(state.sched?.Heating || []).filter((x) => x.id !== editor.schedId).map((x) => `<option value="${x.id}|${editor.day}">${esc(scheduleLabel(x))}</option>`).join('')}</optgroup>
    <optgroup label="This schedule on another day">${DAYS.filter((d) => d !== editor.day).map((d) => `<option value="${editor.schedId}|${d}">${d}</option>`).join('')}</optgroup>`;
  const others = sharing.filter((x) => x.id !== editor.roomId).map(roomName);
  const sharedNote = r
    ? `Uses the schedule “${esc(sched?.Name)}”${others.length ? `, shared with ${esc(others.join(', '))}` : ''}`
    : sharing.length ? `Used by ${esc(sharing.map(roomName).join(', '))}` : 'Not used by any room';

  setDialogHTML(dlg, `
    <div class="sheet-head">
      <div class="room-ico">${icon(r ? roomIcon(r) : 'calendar-days')}</div>
      <div class="grow"><h2 id="editorTitle">${esc(title)}</h2><p>${editor.day}. ${sharedNote}.</p></div>
      <button class="icon-btn" data-ed="close" aria-label="Close without applying">${icon('x')}</button>
    </div>
    <div class="sheet-body">
      <section>
        <div class="field-label">${r ? 'This room’s week' : 'This schedule’s week'}<span class="hint">Pick a day to edit</span></div>
        <div class="mini-week">${mini}</div>
      </section>
      <section>
        <div class="field-label">${editor.day}</div>
        <div class="big-band-wrap" id="bigWrap"><div class="big-band" id="bigBand">${bigBandHTML()}</div>${handles}</div>
        <div class="big-axis">${[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => `<span style="left:calc(8px + (100% - 16px) * ${h / 24})">${String(h).padStart(2, '0')}</span>`).join('')}</div>
        <p class="band-hint">Drag a marker to move it, or use the arrow keys. Hold Shift for 5-minute steps.</p>
      </section>
      <section>
        <div class="field-label">Changes through the day</div>
        <div class="points">${carryRow}${pointRows}</div>
        <div style="margin-top:10px"><button class="btn small" data-ed="add" data-k="ed-add">${icon('plus')}Add a change</button></div>
      </section>
      <section class="copy-from">
        <div class="field-label">Start from another schedule</div>
        <select data-ed="copy" data-k="ed-copy"><option value="">Copy ${editor.day} from…</option>${copyOpts}</select>
      </section>
      <section>
        <div class="field-label">Apply to these days</div>
        <div class="chips">${DAYS.map((d) => `<button class="chip" data-ed="aday" data-day="${d}" aria-pressed="${editor.applyDays.has(d)}" data-k="ad-${d}">${SHORT[d]}</button>`).join('')}</div>
        <div class="chip-links">
          <button data-ed="days-preset" data-v="weekdays">Weekdays</button>
          <button data-ed="days-preset" data-v="weekend">Weekend</button>
          <button data-ed="days-preset" data-v="all">Every day</button>
          <button data-ed="days-preset" data-v="one">Just ${editor.day}</button>
        </div>
      </section>
      ${r ? `<section>
        <div class="field-label">Apply to these rooms${sharing.length > 1 ? '<span class="hint">Rooms sharing this schedule always change together</span>' : ''}</div>
        <div class="chips">${schedRooms.map((x) => {
          const same = x.ScheduleId === editor.schedId;
          return `<button class="chip" data-ed="aroom" data-room="${x.id}" aria-pressed="${same || editor.applyRooms.has(x.id)}" ${same ? 'disabled' : ''} data-k="ar-${x.id}">${icon(roomIcon(x))}${esc(roomName(x))}</button>`;
        }).join('')}</div>
        <div class="chip-links">
          <button data-ed="rooms-preset" data-v="all">Every room</button>
          <button data-ed="rooms-preset" data-v="one">Just ${esc(roomName(r))}</button>
        </div>
      </section>` : ''}
    </div>
    <div class="sheet-foot">
      <div class="summary">Updates ${nRooms ? `${nRooms} ${nRooms === 1 ? 'room' : 'rooms'}` : 'the schedule'} on ${nDays} ${nDays === 1 ? 'day' : 'days'}. Nothing reaches the hub until you save.</div>
      <button class="btn ghost" data-ed="close">Cancel</button>
      <button class="btn primary" data-ed="apply" ${nDays ? '' : 'disabled'}>${icon('check')}Apply</button>
    </div>`);
  if (k) $(`[data-k="${CSS.escape(k)}"]`, dlg)?.focus();
}

function editorChanged() { editor.dirty = true; renderEditor(); }

function closeEditor(force) {
  if (!force && editor?.dirty && !confirm('Close without applying your changes?')) return;
  editor = null;
  $('#editor').close();
}

function applyEditor() {
  const dayObj = normaliseDay(editor.points);
  const targets = editorTargets();
  for (const id of targets) for (const d of editor.applyDays) setDraftDay(id, d, dayObj);
  const n = targets.size;
  closeEditor(true);
  renderMain();
  renderDraftBar();
  toast(state.drafts.size ? `Updated ${n} ${n === 1 ? 'schedule' : 'schedules'}. Save to hub when you're ready.` : 'No changes to save');
}

function addPoint() {
  const pts = editor.points;
  let m;
  if (!pts.length) m = 7 * 60;
  else {
    // Put the new change in the middle of the biggest gap.
    const edges = [0, ...pts.map((p) => p.m), 1440];
    let best = 0;
    for (let i = 1; i < edges.length; i++) if (edges[i] - edges[i - 1] > edges[best + 1] - edges[best]) best = i - 1;
    m = Math.round((edges[best] + edges[best + 1]) / 2 / 15) * 15;
    if (pts.some((p) => p.m === m)) m = Math.min(1435, m + 5);
  }
  pts.push({ m, c: 180 });
  pts.sort((a, b) => a.m - b.m);
  editorChanged();
}

function onEditorClick(e) {
  if (e.target === $('#editor')) return closeEditor();
  const b = e.target.closest('[data-ed]');
  if (!b || b.tagName === 'SELECT' || b.tagName === 'INPUT') return;
  const i = Number(b.dataset.i);
  const p = editor.points[i];
  switch (b.dataset.ed) {
    case 'close': return closeEditor();
    case 'apply': return applyEditor();
    case 'add': return addPoint();
    case 'remove': editor.points.splice(i, 1); return editorChanged();
    case 'temp':
      p.c = clamp(round05(p.c + Number(b.dataset.d)), MIN_T, MAX_T);
      editor.lastC = p.c;
      return editorChanged();
    case 'off':
      if (p.c === OFF) p.c = editor.lastC || 180;
      else { editor.lastC = p.c; p.c = OFF; }
      return editorChanged();
    case 'day': {
      const d = b.dataset.day;
      if (d === editor.day) return;
      if (editor.dirty && !confirm(`Switch to ${d}? Changes to ${editor.day} that you haven't applied will be lost.`)) return;
      editor.day = d;
      editor.points = toPoints(daysOf(editor.schedId)[d]);
      editor.applyDays = new Set([d]);
      editor.dirty = false;
      return renderEditor();
    }
    case 'aday': {
      const d = b.dataset.day;
      editor.applyDays.has(d) ? editor.applyDays.delete(d) : editor.applyDays.add(d);
      return renderEditor();
    }
    case 'days-preset': {
      const v = b.dataset.v;
      editor.applyDays = new Set(v === 'weekdays' ? DAYS.slice(0, 5) : v === 'weekend' ? DAYS.slice(5) : v === 'all' ? DAYS : [editor.day]);
      return renderEditor();
    }
    case 'aroom': {
      const id = Number(b.dataset.room);
      editor.applyRooms.has(id) ? editor.applyRooms.delete(id) : editor.applyRooms.add(id);
      return renderEditor();
    }
    case 'rooms-preset':
      editor.applyRooms = new Set(b.dataset.v === 'all' ? rooms().filter((x) => schedFor(x)).map((x) => x.id) : [editor.roomId]);
      return renderEditor();
  }
}

function onEditorChange(e) {
  const el = e.target;
  if (el.dataset.ed === 'time') {
    const i = Number(el.dataset.i);
    const [h, mm] = el.value.split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(mm)) { el.value = fmtMin(editor.points[i].m); return; }
    const m = h * 60 + mm;
    if (editor.points.some((p, j) => j !== i && p.m === m)) {
      toast(`There's already a change at ${fmtMin(m)}`, true);
      el.value = fmtMin(editor.points[i].m);
      return;
    }
    const pt = editor.points[i];
    pt.m = m;
    editor.points.sort((a, b) => a.m - b.m);
    el.dataset.k = `t-${editor.points.indexOf(pt)}`;
    editorChanged();
  } else if (el.dataset.ed === 'copy' && el.value) {
    const [sid, d] = el.value.split('|');
    editor.points = toPoints(daysOf(Number(sid))[d]);
    toast(`Copied ${origSched(Number(sid))?.Name || 'schedule'} on ${d}. Apply to keep it.`);
    editorChanged();
  }
}

// Dragging the markers on the big band.
let drag = null;
function onHandleDown(e) {
  const h = e.target.closest('.handle');
  if (!h) return;
  e.preventDefault();
  const i = Number(h.dataset.i);
  drag = { i, h, pt: editor.points[i] };
  h.classList.add('drag');
  h.setPointerCapture(e.pointerId);
  h.focus();
}
function moveHandleTo(i, m) {
  const pts = editor.points;
  const lo = i > 0 ? pts[i - 1].m + 5 : 0;
  const hi = i < pts.length - 1 ? pts[i + 1].m - 5 : 1435;
  pts[i].m = clamp(m, lo, hi);
  const h = $(`.handle[data-i="${i}"]`, $('#editor'));
  h.style.left = `calc(8px + (100% - 16px) * ${pts[i].m / 1440})`;
  $('.tag', h).textContent = fmtMin(pts[i].m);
  $('#bigBand').innerHTML = bigBandHTML();
  editor.dirty = true;
}
function onHandleMove(e) {
  if (!drag) return;
  const rect = $('#bigBand').getBoundingClientRect();
  const step = e.shiftKey ? 5 : 15;
  const m = Math.round((((e.clientX - rect.left) / rect.width) * 1440) / step) * step;
  moveHandleTo(drag.i, m);
}
function onHandleUp() {
  if (!drag) return;
  drag = null;
  renderEditor();
}
function onHandleKey(e) {
  const h = e.target.closest?.('.handle');
  if (!h || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  e.preventDefault();
  const i = Number(h.dataset.i);
  const step = e.shiftKey ? 5 : 15;
  moveHandleTo(i, editor.points[i].m + (e.key === 'ArrowLeft' ? -step : step));
  clearTimeout(onHandleKey.t);
  onHandleKey.t = setTimeout(renderEditor, 600);
}

// ---------------------------------------------------------------------------
// Schedule library: named schedules that one or more rooms can share.

const roomsOn = (schedId) => rooms().filter((r) => r.ScheduleId === schedId);
function scheduleLabel(s) {
  const used = roomsOn(s.id).map(roomName);
  return `${s.Name} (${used.length ? used.join(', ') : 'not used'})`;
}
const libSchedules = () => [...(state.sched?.Heating || [])].sort((a, b) => a.Name.localeCompare(b.Name) || a.id - b.id);

function schedViewSwitch() {
  const v = state.schedView;
  return `<div class="seg view-switch" role="group" aria-label="Schedules view">
    <button data-act="sched-view" data-v="timeline" aria-pressed="${v !== 'library'}">${icon('house')}By room</button>
    <button data-act="sched-view" data-v="library" aria-pressed="${v === 'library'}">${icon('layers')}Schedule library</button>
  </div>`;
}

function libraryView() {
  const list = libSchedules();
  const td = today();
  const cards = list.map((s) => {
    const used = roomsOn(s.id);
    const days = daysOf(s.id);
    const edited = state.drafts.has(s.id);
    const strips = DAYS.map((d) => `<div class="week-strip ${d === td ? 'today' : ''}"><span class="d">${SHORT[d]}${isDayEdited(s.id, d) ? '*' : ''}</span>
      <button class="band" data-act="lib-edit" data-sched="${s.id}" data-day="${d}" aria-label="Edit ${esc(s.Name)} on ${d}">${bandInner(toPoints(days[d]), carryInto(days, d), { minLabel: 7, day: d, roomLabel: s.Name })}${d === td ? '<i class="now-tick"></i>' : ''}</button></div>`).join('');
    return `<article class="lib-card ${used.length ? '' : 'unused'}">
      <div class="lib-head">
        <div class="grow">
          <h3>${esc(s.Name)}</h3>
          <div class="lib-rooms">${used.length
            ? used.map((r) => `<span class="lib-room">${icon(roomIcon(r))}${esc(roomName(r))}</span>`).join('')
            : '<span class="muted">Not used by any room</span>'}</div>
        </div>
        <div class="lib-actions">
          <button class="icon-btn" data-act="lib-rename" data-sched="${s.id}" data-tip="Rename" aria-label="Rename ${esc(s.Name)}">${icon('pencil')}</button>
          <button class="icon-btn" data-act="lib-dup" data-sched="${s.id}" data-tip="Duplicate" aria-label="Duplicate ${esc(s.Name)}">${icon('copy')}</button>
          <button class="icon-btn danger" data-act="lib-delete" data-sched="${s.id}" data-tip="Delete" aria-label="Delete ${esc(s.Name)}">${icon('trash')}</button>
        </div>
      </div>
      <div class="week-strips">${strips}</div>
      <div class="lib-foot">
        <button class="btn small" data-act="lib-rooms" data-sched="${s.id}">${icon('house')}Choose rooms</button>
        <button class="btn small" data-act="lib-edit" data-sched="${s.id}" data-day="${td}">${icon('sliders-horizontal')}Edit times</button>
        ${edited ? `<button class="edited-tag" data-act="revert" data-sched="${s.id}" data-tip="Undo this schedule's unsaved changes">${icon('undo-2')}Edited, undo</button>` : ''}
        <span class="lib-now">${s.CurrentSetpoint != null ? `Now ${fmtT(s.CurrentSetpoint)}` : ''}${s.Next ? `, then ${fmtT(s.Next.DegreesC)} at ${s.Next.Day !== td ? SHORT[s.Next.Day] + ' ' : ''}${fmtMin(hhmm2min(s.Next.Time))}` : ''}</span>
      </div>
    </article>`;
  }).join('');
  const noSched = rooms().filter((r) => !r.ScheduleId);
  return `
    <div class="toolbar">
      ${schedViewSwitch()}
      <div class="spacer"></div>
      <button class="btn ghost" data-act="backups">${icon('archive-restore')}Backups</button>
      <button class="btn primary" data-act="lib-new">${icon('plus')}New schedule</button>
    </div>
    <p class="lib-intro">${list.length} saved ${list.length === 1 ? 'schedule' : 'schedules'}. Rooms that share a schedule always heat to the same times, and editing it changes all of them.${noSched.length ? ` ${esc(noSched.map(roomName).join(', '))} ${noSched.length === 1 ? 'has' : 'have'} no schedule.` : ''}</p>
    <div class="lib-grid">${cards || '<div class="empty">No schedules yet. Create one to get started.</div>'}</div>`;
}

// --- Modal helper -----------------------------------------------------------

let modalHandler = null;
function openModal(html, handler) {
  const dlg = $('#modal');
  modalHandler = handler;
  setDialogHTML(dlg, html);
  if (!dlg.open) dlg.showModal();
  $('input[type="text"], select, button.primary', dlg)?.focus();
}
function closeModal() { modalHandler = null; $('#modal').close(); }

function roomPicker(selected, { schedId } = {}) {
  return `<div class="room-pick">${rooms().map((r) => {
    const cur = schedFor(r);
    const note = !cur ? 'No schedule' : cur.id === schedId ? 'Uses this schedule' : `Uses “${esc(cur.Name)}”`;
    return `<label class="pick"><input type="checkbox" value="${r.id}" ${selected.includes(r.id) ? 'checked' : ''}>
      ${icon(roomIcon(r))}<span><b>${esc(roomName(r))}</b><small>${note}</small></span></label>`;
  }).join('')}</div>`;
}
const pickedRooms = () => $$('#modal .room-pick input:checked').map((i) => Number(i.value));

async function libAction(fn, okMsg) {
  const btn = $('#modal button.primary, #modal button.danger-fill');
  const label = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
  try {
    await fn();
    closeModal();
    toast(okMsg);
  } catch (e) {
    toast(e.message, true);
    if (btn) { btn.disabled = false; btn.innerHTML = label; }
  }
  await settle();
  await refresh();
}

// --- New / duplicate --------------------------------------------------------

function openNewSchedule(copyId = null) {
  const src = copyId ? origSched(copyId) : null;
  const opts = libSchedules().map((s) => `<option value="${s.id}" ${s.id === copyId ? 'selected' : ''}>A copy of “${esc(s.Name)}”</option>`).join('');
  openModal(`<div class="modal-body">
      <h2>${src ? `Duplicate “${esc(src.Name)}”` : 'New schedule'}</h2>
      <p>Give it a name, choose its starting times, and pick the rooms that should use it. You can change the times afterwards.</p>
      <label class="field">Name<input type="text" id="mName" maxlength="40" value="${src ? esc(`Copy of ${src.Name}`.slice(0, 40)) : ''}" placeholder="For example, Bedrooms"></label>
      <label class="field">Start from<select id="mFrom"><option value="">The hub's standard week (06:30 to 22:30 on weekdays)</option>${opts}</select></label>
      <div class="field">Rooms that use it <small>Optional. Ticking a room moves it off its current schedule.</small></div>
      ${roomPicker([])}
    </div>
    <div class="modal-foot">
      <button class="btn ghost" data-md="cancel">Cancel</button>
      <button class="btn primary" data-md="create">${icon('plus')}Create schedule</button>
    </div>`, (act) => {
    if (act !== 'create') return;
    const name = $('#mName').value.trim();
    if (!name) { toast('Give the schedule a name', true); $('#mName').focus(); return; }
    const from = Number($('#mFrom').value) || null;
    const body = { name, rooms: pickedRooms() };
    if (from) body.days = daysOf(from); // includes any unsaved edits you've made to it
    libAction(() => api('POST', '/api/library', body), `Created “${name}”`);
  });
}

// --- Rename -----------------------------------------------------------------

function openRename(id) {
  const s = origSched(id);
  openModal(`<div class="modal-body">
      <h2>Rename schedule</h2>
      <label class="field">Name<input type="text" id="mName" maxlength="40" value="${esc(s.Name)}"></label>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" data-md="cancel">Cancel</button>
      <button class="btn primary" data-md="save">${icon('check')}Rename</button>
    </div>`, (act) => {
    if (act !== 'save') return;
    const name = $('#mName').value.trim();
    if (!name) { toast('Give the schedule a name', true); return; }
    if (name === s.Name) return closeModal();
    libAction(() => api('PATCH', `/api/library/${id}`, { name }), `Renamed to “${name}”`);
  });
}

// --- Choose rooms -----------------------------------------------------------

function roomsSummary(id, picked) {
  const before = roomsOn(id).map((r) => r.id);
  const moved = picked.filter((rid) => !before.includes(rid)).map(roomById).filter((r) => r.ScheduleId);
  const added = picked.filter((rid) => !before.includes(rid)).map(roomById).filter((r) => !r.ScheduleId);
  const dropped = before.filter((rid) => !picked.includes(rid)).map(roomById);
  const lines = [];
  if (added.length) lines.push(`${esc(added.map(roomName).join(', '))} will start following this schedule.`);
  if (moved.length) lines.push(`${moved.map((r) => `${esc(roomName(r))} moves off “${esc(schedFor(r).Name)}”`).join('. ')}.`);
  if (dropped.length) lines.push(`${esc(dropped.map(roomName).join(', '))} will be left with no schedule, so ${dropped.length === 1 ? 'it' : 'they'} will only follow manual settings.`);
  return lines.length ? lines.join(' ') : 'No change yet.';
}

function openChooseRooms(id, preselect = null) {
  const s = origSched(id);
  const current = roomsOn(id).map((r) => r.id);
  openModal(`<div class="modal-body">
      <h2>Rooms using “${esc(s.Name)}”</h2>
      <p>Tick every room that should follow this schedule. This changes the hub straight away.</p>
      ${roomPicker(preselect || current, { schedId: id })}
      <p class="pick-summary" id="mSummary"></p>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" data-md="cancel">Cancel</button>
      <button class="btn primary" data-md="save">${icon('check')}Save rooms</button>
    </div>`, (act) => {
    if (act === 'pick') { $('#mSummary').innerHTML = roomsSummary(id, pickedRooms()); return; }
    if (act !== 'save') return;
    const picked = pickedRooms();
    if (picked.length === current.length && picked.every((r) => current.includes(r))) return closeModal();
    libAction(() => api('PUT', `/api/library/${id}/rooms`, { rooms: picked }), `“${s.Name}” is now used by ${picked.length} ${picked.length === 1 ? 'room' : 'rooms'}`);
  });
  $('#mSummary').innerHTML = roomsSummary(id, pickedRooms());
}

// A room's own "which schedule?" picker, used from the room timeline.
function openRoomSchedule(roomId) {
  const r = roomById(roomId);
  const cur = schedFor(r);
  openModal(`<div class="modal-body">
      <h2>Schedule for ${esc(roomName(r))}</h2>
      <p>${cur ? `It currently follows “${esc(cur.Name)}”.` : 'It has no schedule at the moment.'} Pick the schedule it should follow. This changes the hub straight away.</p>
      <div class="sched-pick">${libSchedules().map((s) => {
        const days = daysOf(s.id);
        return `<label class="pick"><input type="radio" name="mSched" value="${s.id}" ${cur?.id === s.id ? 'checked' : ''}>
          <span><b>${esc(s.Name)}</b><small>${esc(roomsOn(s.id).filter((x) => x.id !== r.id).map(roomName).join(', ') || 'No other rooms')}</small></span>
          <span class="band mini-band">${bandInner(toPoints(days[today()]), carryInto(days, today()), { minLabel: 99 })}</span></label>`;
      }).join('')}</div>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" data-md="cancel">Cancel</button>
      <button class="btn primary" data-md="save">${icon('check')}Use this schedule</button>
    </div>`, (act) => {
    if (act !== 'save') return;
    const id = Number($('#modal input[name="mSched"]:checked')?.value);
    if (!id) { toast('Pick a schedule', true); return; }
    if (id === cur?.id) return closeModal();
    const s = origSched(id);
    libAction(() => api('PUT', `/api/library/${id}/rooms`, { rooms: [...roomsOn(id).map((x) => x.id), r.id] }), `${roomName(r)} now follows “${s.Name}”`);
  });
}

// --- Delete -----------------------------------------------------------------

function openDelete(id) {
  const s = origSched(id);
  const used = roomsOn(id);
  const others = libSchedules().filter((x) => x.id !== id);
  openModal(`<div class="modal-body">
      <h2>Delete “${esc(s.Name)}”?</h2>
      ${used.length ? `<p>${esc(used.map(roomName).join(', '))} ${used.length === 1 ? 'uses' : 'use'} this schedule. Choose what ${used.length === 1 ? 'it' : 'they'} should follow instead.</p>
        <label class="field">Move ${used.length === 1 ? 'the room' : 'the rooms'} to<select id="mMove">
          ${others.map((x) => `<option value="${x.id}">${esc(scheduleLabel(x))}</option>`).join('')}
          <option value="">No schedule (manual control only)</option>
        </select></label>`
      : '<p>No rooms use this schedule.</p>'}
      <p class="muted">A backup is saved first, so you can restore it from Backups.</p>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" data-md="cancel">Cancel</button>
      <button class="btn danger-fill" data-md="delete">${icon('trash')}Delete schedule</button>
    </div>`, (act) => {
    if (act !== 'delete') return;
    const move = $('#mMove')?.value;
    libAction(async () => { await api('DELETE', `/api/library/${id}${move ? `?moveTo=${move}` : ''}`); state.drafts.delete(id); }, `Deleted “${s.Name}”`);
  });
}

// ---------------------------------------------------------------------------
// Room order and groups (Upstairs, Downstairs…), shared by the schedule timeline and the Rooms tab.
// The server keeps them in data/layout.json. Rooms it doesn't know yet go after the ungrouped rooms.

let layoutPending = 0;
let layoutSaving = Promise.resolve();

// { loose: rooms not in a group, groups: [{ id, name, list: rooms }] }, in display order.
function roomGroups() {
  const seen = new Set();
  const take = (ids) => (ids || []).map(roomById).filter((r) => {
    if (!r || seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
  const groups = (state.layout.groups || []).map((g) => ({ id: g.id, name: g.name, list: take(g.rooms) }));
  const loose = take(state.layout.rooms);
  return { loose: [...loose, ...rooms().filter((r) => !seen.has(r.id))], groups };
}
const layoutOf = ({ loose, groups }) => ({ rooms: loose.map((r) => r.id), groups: groups.map((g) => ({ id: g.id, name: g.name, rooms: g.list.map((r) => r.id) })) });

function saveLayout(next) {
  state.layout = next;
  renderMain();
  layoutPending++;
  layoutSaving = layoutSaving
    .then(() => api('PUT', '/api/layout', next))
    .catch((e) => toast(`Couldn't save the room order: ${e.message}`, true))
    .finally(() => { layoutPending--; });
}

const dragHandle = (kind, id, name) => `<button type="button" class="drag-handle" data-drag="${kind}" data-id="${esc(id)}" data-k="drag-${kind}-${esc(id)}" data-tip="Drag to move" aria-label="Move ${esc(name)}${kind === 'group' ? ' group' : ''}. Drag it, or use the arrow keys.">${icon('grip-vertical')}</button>`;

// Ungrouped rooms first, then each group under its own heading. `item` renders one room.
function layoutSections(item, { select = false, bodyClass = '' } = {}) {
  const { loose, groups } = roomGroups();
  const body = (list, hint) => `<div class="lay-body ${bodyClass}">${list.map(item).join('') || (hint ? '<div class="lay-hint">Drag rooms here by their handles</div>' : '')}</div>`;
  const head = (g) => {
    const sched = g.list.filter(schedFor);
    const all = sched.length && sched.every((r) => state.selected.has(r.id));
    return `<div class="lay-head">
      ${select ? `<input type="checkbox" class="room-check" data-act="select-group" data-group="${esc(g.id)}" data-k="selg-${esc(g.id)}" ${all ? 'checked' : ''} ${sched.length ? '' : 'disabled'} aria-label="Select every room in ${esc(g.name)}">` : ''}
      <button class="group-name" data-act="group-rename" data-group="${esc(g.id)}" data-tip="Rename this group">${esc(g.name)}</button>
      <span class="group-count">${g.list.length} ${g.list.length === 1 ? 'room' : 'rooms'}</span>
      <button class="icon-btn group-del" data-act="group-delete" data-group="${esc(g.id)}" data-tip="Delete this group. Its rooms stay." aria-label="Delete the ${esc(g.name)} group">${icon('trash')}</button>
      ${dragHandle('group', g.id, g.name)}
    </div>`;
  };
  return `<section class="lay-section" data-group="">${body(loose, false)}</section>`
    + groups.map((g) => `<section class="lay-section" data-group="${esc(g.id)}">${head(g)}${body(g.list, true)}</section>`).join('');
}

function openGroupName(id = null) {
  const g = state.layout.groups.find((x) => x.id === id);
  openModal(`<div class="modal-body">
      <h2>${g ? 'Rename group' : 'New group'}</h2>
      ${g ? '' : '<p>Groups sort your rooms, for example Upstairs and Downstairs. Drag a room by the handle on its right to move it into a group. They show on the Schedules and Rooms tabs, and don\'t change anything on the hub.</p>'}
      <label class="field">Name<input type="text" id="mName" maxlength="40" value="${g ? esc(g.name) : ''}" placeholder="For example, Upstairs"></label>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" data-md="cancel">Cancel</button>
      <button class="btn primary" data-md="save">${icon(g ? 'check' : 'plus')}${g ? 'Rename' : 'Create group'}</button>
    </div>`, (act) => {
    if (act !== 'save') return;
    const name = $('#mName').value.trim().slice(0, 40);
    if (!name) { toast('Give the group a name', true); $('#mName').focus(); return; }
    const next = layoutOf(roomGroups());
    if (g) next.groups.find((x) => x.id === g.id).name = name;
    else next.groups.push({ id: 'g' + Date.now().toString(36), name, rooms: [] });
    closeModal();
    saveLayout(next);
    if (!g) toast(`Created “${name}”. Drag rooms into it by their handles.`);
  });
}

function deleteGroup(id) {
  const secs = roomGroups();
  const g = secs.groups.find((x) => x.id === id);
  if (!g) return;
  if (g.list.length && !confirm(`Delete the “${g.name}” group? Its ${g.list.length === 1 ? 'room stays' : 'rooms stay'}, and ${g.list.length === 1 ? 'moves' : 'move'} up with the ungrouped rooms.`)) return;
  secs.loose.push(...g.list);
  secs.groups = secs.groups.filter((x) => x !== g);
  saveLayout(layoutOf(secs));
}

// Arrow keys on a handle: a room steps one place, crossing into the next group at either end.
function moveByKey(kind, id, dir) {
  const secs = roomGroups();
  if (kind === 'group') {
    const i = secs.groups.findIndex((g) => g.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= secs.groups.length) return;
    [secs.groups[i], secs.groups[j]] = [secs.groups[j], secs.groups[i]];
  } else {
    const lists = [secs.loose, ...secs.groups.map((g) => g.list)];
    const li = lists.findIndex((l) => l.some((r) => r.id === id));
    if (li < 0) return;
    const list = lists[li], i = list.findIndex((r) => r.id === id);
    if (dir < 0 ? i > 0 : i < list.length - 1) list.splice(i + dir, 0, ...list.splice(i, 1));
    else if (lists[li + dir]) {
      const [r] = list.splice(i, 1);
      if (dir < 0) lists[li - 1].push(r); else lists[li + 1].unshift(r);
    } else return;
  }
  saveLayout(layoutOf(secs));
}

// Dragging. The row or card lifts out and follows the pointer, and a placeholder shows where it will land.
// Dragging a group folds every group down to its heading until it's dropped.
let rowDrag = null;

function onDragStart(e) {
  const h = e.target.closest?.('.drag-handle');
  if (!h || e.button !== 0 || !h.closest('#main')) return;
  e.preventDefault();
  hideTip();
  const root = h.closest('.lay-root');
  const group = h.dataset.drag === 'group';
  const el = h.closest(group ? '.lay-section' : '.lay-item');
  const start = el.getBoundingClientRect();
  const dx = e.clientX - start.left, dy = e.clientY - start.top;
  if (group) {
    // Fold to headings, then scroll so the held group stays under the pointer.
    root.classList.add('groups-only');
    scrollBy(0, el.getBoundingClientRect().top - start.top);
  }
  const rect = el.getBoundingClientRect();
  const ph = document.createElement('div');
  ph.className = 'lay-placeholder';
  ph.style.height = `${rect.height}px`;
  el.before(ph);
  const css = el.style.cssText;
  Object.assign(el.style, { position: 'fixed', left: `${rect.left}px`, top: `${e.clientY - dy}px`, width: `${rect.width}px`, height: `${rect.height}px`, margin: '0' });
  el.classList.add('lifted');
  document.body.classList.add('row-dragging');
  h.setPointerCapture(e.pointerId);
  rowDrag = { group, el, ph, root, css, dx, dy, x: e.clientX, y: e.clientY, free: !group && el.classList.contains('card') };
  rowDrag.raf = requestAnimationFrame(dragScroll);
}

function dragPlace() {
  const d = rowDrag;
  d.el.style.top = `${d.y - d.dy}px`;
  if (d.free) d.el.style.left = `${d.x - d.dx}px`;

  if (d.group) {
    const secs = $$(':scope > .lay-section:not([data-group=""])', d.root).filter((s) => s !== d.el);
    const next = secs.find((s) => { const r = s.getBoundingClientRect(); return d.y < r.top + r.height / 2; });
    if (next) { if (d.ph.nextElementSibling !== next) next.before(d.ph); }
    else if (d.root.lastElementChild !== d.ph) d.root.append(d.ph);
    return;
  }

  const box = d.root.getBoundingClientRect();
  const x = clamp(d.x, box.left + 2, box.right - 2);
  const hit = document.elementFromPoint(x, d.y)?.closest('.lay-item, .lay-head, .lay-body, .lay-placeholder');
  if (!hit || hit === d.ph || !d.root.contains(hit)) return;
  const before = (el) => { if (el.previousElementSibling !== d.ph) el.before(d.ph); };
  const after = (el) => { if (el.nextElementSibling !== d.ph) el.after(d.ph); };
  const side = (el) => {
    const r = el.getBoundingClientRect();
    return d.free ? x > r.left + r.width / 2 : d.y > r.top + r.height / 2;
  };

  if (hit.classList.contains('lay-head')) {
    // Top half of a group heading: end of the section above. Bottom half: start of this group.
    const r = hit.getBoundingClientRect();
    const sec = hit.parentNode;
    if (d.y < r.top + r.height / 2) {
      const body = $(':scope > .lay-body', sec.previousElementSibling);
      if (body.lastElementChild !== d.ph) body.append(d.ph);
    } else {
      const body = $(':scope > .lay-body', sec);
      if (body.firstElementChild !== d.ph) body.prepend(d.ph);
    }
  } else if (hit.classList.contains('lay-item')) {
    if (side(hit)) after(hit); else before(hit);
  } else {
    // The gap between cards, or an empty group: go by the nearest room.
    const items = $$(':scope > .lay-item', hit).filter((c) => c !== d.el);
    if (!items.length) { if (d.ph.parentNode !== hit) hit.append(d.ph); return; }
    const dist = (c) => {
      const r = c.getBoundingClientRect();
      return Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - d.y, 0, d.y - r.bottom));
    };
    const near = items.reduce((a, b) => (dist(b) < dist(a) ? b : a));
    if (side(near)) after(near); else before(near);
  }
}

function dragScroll() {
  const d = rowDrag;
  if (!d) return;
  const edge = 70;
  const v = d.y < edge ? d.y - edge : d.y > innerHeight - edge ? d.y - (innerHeight - edge) : 0;
  if (v) { scrollBy(0, v / 3); dragPlace(); }
  d.raf = requestAnimationFrame(dragScroll);
}

function onDragMove(e) {
  if (!rowDrag) return;
  rowDrag.x = e.clientX;
  rowDrag.y = e.clientY;
  dragPlace();
}

function onDragEnd() {
  const d = rowDrag;
  if (!d) return;
  cancelAnimationFrame(d.raf);
  d.ph.replaceWith(d.el);
  d.el.style.cssText = d.css;
  d.el.classList.remove('lifted');
  d.root.classList.remove('groups-only');
  document.body.classList.remove('row-dragging');
  rowDrag = null;
  const next = layoutFromDom(d.root);
  if (JSON.stringify(next) !== JSON.stringify(layoutOf(roomGroups()))) saveLayout(next);
  else renderMain();
}

function layoutFromDom(root) {
  const ids = (sec) => $$(':scope > .lay-body > .lay-item', sec).map((x) => Number(x.dataset.room));
  const secs = $$(':scope > .lay-section', root);
  const names = new Map(state.layout.groups.map((g) => [g.id, g.name]));
  return {
    rooms: ids(secs.find((s) => !s.dataset.group)),
    groups: secs.filter((s) => s.dataset.group).map((s) => ({ id: s.dataset.group, name: names.get(s.dataset.group), rooms: ids(s) })),
  };
}

// ---------------------------------------------------------------------------
// Saving and backups

async function saveDrafts() {
  if (!state.drafts.size || state.saving) return;
  const changes = [...state.drafts].map(([id, days]) => {
    const orig = pickDays(origSched(id));
    return { id, days: Object.fromEntries(DAYS.filter((d) => !sameDay(days[d], orig[d])).map((d) => [d, days[d]])) };
  });
  state.saving = true;
  renderDraftBar();
  try {
    await api('PUT', '/api/schedules', { changes, reason: `Before saving ${changes.length} schedule(s) from the control panel` });
    state.drafts.clear();
    toast(`Saved ${changes.length} ${changes.length === 1 ? 'schedule' : 'schedules'} to the hub. A backup of the old ones was kept.`);
  } catch (e) {
    toast(`Save failed: ${e.message}`, true);
  }
  state.saving = false;
  await refresh();
}

async function openBackups() {
  const dlg = $('#modal');
  setDialogHTML(dlg, `<div class="modal-body"><h2>Schedule backups</h2><p>Loading…</p></div>`);
  if (!dlg.open) dlg.showModal();
  let list = [];
  try { list = await api('GET', '/api/backups'); } catch (e) { toast(e.message, true); }
  setDialogHTML(dlg, `<div class="modal-body">
      <h2>Schedule backups</h2>
      <p>A copy of every room's schedule is saved automatically before each change. Restoring one puts all schedules back as they were then.</p>
      <div class="backup-list">${list.length ? list.map((b) => `<div class="backup">
          ${icon('archive-restore')}
          <div class="grow"><b>${new Date(b.savedAt).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</b><small>${esc(b.reason)}</small></div>
          <button class="btn small" data-bk="restore" data-name="${esc(b.name)}">${icon('rotate-ccw')}Restore</button>
        </div>`).join('') : '<div class="empty" style="padding:30px">No backups yet. One is made the first time you save.</div>'}</div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-bk="now">${icon('save')}Back up now</button>
      <button class="btn primary" data-bk="close">Done</button>
    </div>`);
}

async function onModalClick(e) {
  const dlg = $('#modal');
  if (e.target === dlg) return closeModal();
  const md = e.target.closest('[data-md]');
  if (md) return md.dataset.md === 'cancel' ? closeModal() : modalHandler?.(md.dataset.md, md);
  const b = e.target.closest('[data-bk]');
  if (!b) return;
  if (b.dataset.bk === 'close') return dlg.close();
  if (b.dataset.bk === 'now') {
    try { await api('POST', '/api/backups'); toast('Backup saved'); } catch (err) { toast(err.message, true); }
    return openBackups();
  }
  if (b.dataset.bk === 'restore') {
    if (state.drafts.size && !confirm('You have unsaved changes. Restoring will discard them. Continue?')) return;
    if (!confirm('Restore every schedule from this backup? The current schedules are backed up first.')) return;
    b.disabled = true;
    try {
      await api('POST', `/api/backups/${encodeURIComponent(b.dataset.name)}/restore`);
      state.drafts.clear();
      toast('Schedules restored');
      dlg.close();
    } catch (err) { toast(err.message, true); b.disabled = false; }
    await refresh();
  }
}

// ---------------------------------------------------------------------------
// Toasts & tooltips

// Open dialogs sit in the browser's top layer, so floating UI must live inside them to be seen.
function lift(el) {
  const host = $('dialog[open]') || document.body;
  if (el.parentNode !== host) host.append(el);
  return el;
}

function toast(msg, error = false) {
  const el = document.createElement('div');
  el.className = `toast ${error ? 'error' : ''}`;
  el.innerHTML = `${icon(error ? 'circle-alert' : 'check')}<span>${esc(msg)}</span>`;
  lift($('#toasts')).append(el);
  setTimeout(() => el.remove(), error ? 7000 : 3800);
}

const tip = () => $('#tooltip');
function showTip(html, e) {
  const t = lift(tip());
  t.innerHTML = html;
  t.hidden = false;
  placeTip(e);
}
function placeTip(e) {
  const t = tip();
  const w = t.offsetWidth, h = t.offsetHeight;
  t.style.left = `${clamp(e.clientX + 14, 8, innerWidth - w - 8)}px`;
  t.style.top = `${e.clientY + 18 + h > innerHeight ? e.clientY - h - 12 : e.clientY + 18}px`;
}
const hideTip = () => { tip().hidden = true; };

// ---------------------------------------------------------------------------
// Events

document.addEventListener('click', (e) => {
  const pop = $('#popover');
  if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('[data-act="boost-open"]')) closePopover();

  const tab = e.target.closest('.tabs button');
  if (tab) {
    state.view = tab.dataset.view;
    store.set('view', state.view);
    renderHeader();
    renderBanner();
    renderMain();
    if (state.view === 'rooms' || state.view === 'diagnostics') loadHistory();
    if (state.view === 'diagnostics') loadDiagnostics();
    return;
  }
  if (e.target.closest('#refreshBtn')) return refresh();
  if (e.target.closest('#themeBtn')) {
    setTheme(isDark() ? 'light' : 'dark');
    if (state.view === 'settings') renderMain();
    return;
  }

  const b = e.target.closest('[data-act]');
  if (!b || b.tagName === 'SELECT' || b.closest('dialog')) return;
  const r = b.dataset.room && b.dataset.room !== 'all' ? roomById(b.dataset.room) : null;
  switch (b.dataset.act) {
    case 'refresh': return refresh();
    case 'open-settings': state.view = 'settings'; store.set('view', state.view); renderAll(); return scrollTo(0, 0);
    case 'theme-set': setTheme(b.dataset.v); return renderMain();
    case 'set-choice': return saveSettings({ [b.dataset.key]: Number(b.dataset.v) }, 'Saved');
    case 'set-test': return testHubConnection();
    case 'pick-icon': return openIconPicker(Number(b.dataset.room));
    case 'find-hub': return findHub();
    case 'use-hub': return useHub(b.dataset.ip);
    case 'setup-next': return setupNext();
    case 'setup-back': return setupGo(state.setupStep - 1);
    case 'setup-connect': return setupConnect();
    case 'setup-finish': return setupFinish();
    case 'install-app': return installApp();
    case 'pw-change': return openPasswordModal();
    case 'pw-remove': return openPasswordModal(true);
    case 'sign-out': return signOut();
    case 'set-save-hub': return saveHubConnection();
    case 'mode': state.mode = b.dataset.v; store.set('mode', state.mode); return renderMain();
    case 'sched-view': state.schedView = b.dataset.v; store.set('schedView', state.schedView); return renderMain();
    case 'lib-new': return openNewSchedule();
    case 'lib-dup': return openNewSchedule(Number(b.dataset.sched));
    case 'lib-rename': return openRename(Number(b.dataset.sched));
    case 'lib-rooms': return openChooseRooms(Number(b.dataset.sched));
    case 'lib-delete': return openDelete(Number(b.dataset.sched));
    case 'lib-edit': return openEditorFor(Number(b.dataset.sched), b.dataset.day || today());
    case 'room-sched': return openRoomSchedule(Number(b.dataset.room));
    case 'day': state.day = b.dataset.day; return renderMain();
    case 'select':
      b.checked ? state.selected.add(r.id) : state.selected.delete(r.id);
      return renderMain();
    case 'select-all': {
      const ids = rooms().filter((x) => schedFor(x)).map((x) => x.id);
      state.selected = b.checked ? new Set(ids) : new Set();
      return renderMain();
    }
    case 'select-group': {
      const g = roomGroups().groups.find((x) => x.id === b.dataset.group);
      for (const x of (g?.list || []).filter(schedFor)) b.checked ? state.selected.add(x.id) : state.selected.delete(x.id);
      return renderMain();
    }
    case 'group-new': return openGroupName();
    case 'group-rename': return openGroupName(b.dataset.group);
    case 'group-delete': return deleteGroup(b.dataset.group);
    case 'clear-sel': state.selected.clear(); return renderMain();
    case 'edit': {
      const preset = state.selected.has(r.id) && state.selected.size > 1 ? selectedSchedRooms().map((x) => x.id) : null;
      return openEditor(r.id, b.dataset.day, preset);
    }
    case 'edit-together': {
      const sel = selectedSchedRooms();
      if (sel.length) openEditor(sel[0].id, state.mode === 'day' ? state.day : today(), sel.map((x) => x.id));
      return;
    }
    case 'nudge': {
      const d = Number(b.dataset.d);
      return bulkEdit((pts) => pts.map((p) => ({ m: p.m, c: p.c === OFF ? OFF : clamp(round05(p.c + d), MIN_T, MAX_T) })));
    }
    case 'shift': {
      const d = Number(b.dataset.d);
      return bulkEdit((pts) => pts.map((p) => ({ m: clamp(p.m + d, 0, 1435), c: p.c })));
    }
    case 'revert': state.drafts.delete(Number(b.dataset.sched)); renderMain(); return renderDraftBar();
    case 'discard-all':
      if (!confirm('Discard all unsaved schedule changes?')) return;
      state.drafts.clear(); renderMain(); return renderDraftBar();
    case 'save': return saveDrafts();
    case 'backups': return openBackups();
    case 'room-mode': return setRoomMode(r, b.dataset.v);
    case 'temp': return nudgeRoomTemp(r, Number(b.dataset.d));
    case 'boost-pick': return openBoostPicker();
    case 'boost-open':
      if (!$('#popover').hidden) return closePopover();
      return openBoost(b, b.dataset.room);
    case 'cancel-boost': return cancelOverrides([r]);
    case 'cancel-all': return cancelOverrides(state.domain.Room.filter((x) => overrideInfo(x)));
    case 'away': return setAway(b.dataset.on === '1');
    case 'eco': return act(() => api('PATCH', '/api/system', { EcoModeEnabled: b.dataset.on === '1' }), `Eco mode ${b.dataset.on === '1' ? 'on' : 'off'}`);
    case 'comfort': return act(() => api('PATCH', '/api/system', { ComfortModeEnabled: b.dataset.on === '1' }), `Comfort mode ${b.dataset.on === '1' ? 'on' : 'off'}`);
    case 'plug-mode': return act(() => api('PATCH', `/api/plug/${b.dataset.plug}`, { Mode: b.dataset.v }), `Plug set to ${b.dataset.v.toLowerCase()}`);
    case 'away-cap': {
      const cur = state.pendingAwayCap ?? sys().AwayModeSetPointLimit ?? 70;
      const next = clamp(cur + Number(b.dataset.d), MIN_T, 210);
      state.pendingAwayCap = next;
      renderMain();
      clearTimeout(pendingTimers.get('awayCap'));
      pendingTimers.set('awayCap', setTimeout(async () => {
        await act(() => api('PATCH', '/api/system', { AwayModeSetPointLimit: next }), `Away mode temperature set to ${fmtT(next)}`);
        state.pendingAwayCap = null;
        renderMain();
      }, 900));
      return;
    }
    case 'valve-protect': return act(() => api('PATCH', '/api/system', { ValveProtectionEnabled: b.dataset.on === '1' }), `Valve protection ${b.dataset.on === '1' ? 'on' : 'off'}`);
    case 'preheat': return act(() => api('PATCH', '/api/system', { PreheatTimeLimit: Number(b.dataset.v) }), `Pre-heat limit set to ${Number(b.dataset.v) / 3600} h`);
    case 'window-detect': return act(() => api('PATCH', `/api/room/${r.id}`, { WindowDetectionActive: b.dataset.on === '1' }), `Open-window detection ${b.dataset.on === '1' ? 'on' : 'off'} in ${roomName(r)}`);
    case 'dev-lock': return act(() => api('PATCH', `/api/device/${b.dataset.dev}`, { DeviceLockEnabled: b.dataset.on === '1' }), `Buttons ${b.dataset.on === '1' ? 'locked' : 'unlocked'}`);
    case 'plug-out': return act(() => api('PATCH', `/api/plug/${b.dataset.plug}`, { RequestOutput: b.dataset.v }), `Plug turned ${b.dataset.v.toLowerCase()}`);
  }
});

// Settings fields: keep what's typed across re-renders, and save the simple ones when they change.
document.addEventListener('input', (e) => {
  const k = e.target.dataset?.set;
  if (!k) return;
  state.setDraft[k] = e.target.value;
  if (k === 'hubIp' || k === 'secret') state.setTest = null;
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.set === 'title' && state.setupStep == null) return saveSettings({ title: el.value }, 'Title saved');
  if (el.dataset.set === 'pricePerKwh' || el.dataset.act === 'price') {
    const v = Number(el.value);
    if (v > 0) saveSettings({ pricePerKwh: v }, `Unit price set to ${v}p per kWh`);
    return;
  }
  if (el.dataset.act === 'copy-week' && el.value) {
    const src = roomById(el.value);
    const srcDays = daysOf(src.ScheduleId);
    const targets = selectedSchedRooms().filter((x) => x.ScheduleId !== src.ScheduleId);
    for (const t of targets) for (const d of DAYS) setDraftDay(t.ScheduleId, d, structuredClone(srcDays[d]));
    toast(targets.length ? `Copied ${roomName(src)}'s week to ${targets.length} ${targets.length === 1 ? 'room' : 'rooms'}` : 'Pick rooms other than the one you are copying from', !targets.length);
    renderMain();
    renderDraftBar();
  }
});

document.addEventListener('submit', (e) => {
  if (e.target.id !== 'authForm') return;
  e.preventDefault();
  submitAuth();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#popover').hidden) closePopover();
  if (e.key === 'Enter' && state.setupStep != null && e.target.closest?.('.setup-card') && e.target.tagName !== 'BUTTON') {
    e.preventDefault();
    $('.setup-foot .btn.primary')?.click();
    return;
  }
  if (e.key === 'Enter' && (e.target.dataset?.set === 'hubIp' || e.target.dataset?.set === 'secret')) { e.preventDefault(); saveHubConnection(); return; }
  const h = e.target.closest?.('#main .drag-handle');
  if (h && /^Arrow(Up|Down|Left|Right)$/.test(e.key)) {
    e.preventDefault();
    moveByKey(h.dataset.drag, h.dataset.drag === 'group' ? h.dataset.id : Number(h.dataset.id), /Up|Left/.test(e.key) ? -1 : 1);
  }
});

document.addEventListener('pointerdown', onDragStart);
document.addEventListener('pointermove', onDragMove);
document.addEventListener('pointerup', onDragEnd);
document.addEventListener('pointercancel', onDragEnd);

document.addEventListener('mouseover', (e) => {
  if (rowDrag || e.target.closest('.spark')) return;
  const el = e.target.closest('[data-tip]');
  if (el) showTip(el.dataset.tip, e);
});
document.addEventListener('mousemove', (e) => {
  if (e.target.closest('.spark')) return sparkHover(e);
  if (!tip().hidden && e.target.closest('[data-tip]')) placeTip(e);
});
document.addEventListener('mouseout', (e) => {
  const sp = e.target.closest('.spark');
  if (sp && !sp.contains(e.relatedTarget)) {
    for (const x of $$('.spark-cross, .spark-dot', sp)) x.hidden = true;
    hideTip();
  }
  const el = e.target.closest('[data-tip]');
  if (el && !el.contains(e.relatedTarget)) hideTip();
});
document.addEventListener('scroll', hideTip, true);

const ed = $('#editor');
ed.addEventListener('click', onEditorClick);
ed.addEventListener('change', onEditorChange);
ed.addEventListener('pointerdown', onHandleDown);
ed.addEventListener('pointermove', onHandleMove);
ed.addEventListener('pointerup', onHandleUp);
ed.addEventListener('pointercancel', onHandleUp);
ed.addEventListener('keydown', onHandleKey);
ed.addEventListener('cancel', (e) => { e.preventDefault(); closeEditor(); });
$('#modal').addEventListener('click', onModalClick);
$('#modal').addEventListener('change', (e) => { if (e.target.closest('.room-pick')) modalHandler?.('pick'); });
$('#modal').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('input[type="text"], input[type="password"]')) { e.preventDefault(); $('#modal .modal-foot button:last-child')?.click(); }
});

window.addEventListener('beforeunload', (e) => {
  if (state.drafts.size) { e.preventDefault(); e.returnValue = ''; }
});

// ---------------------------------------------------------------------------
// Start

// Light/dark: follows the computer until the header toggle is used, then remembers the choice.
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const isDark = () => (document.documentElement.dataset.theme || (darkQuery.matches ? 'dark' : 'light')) === 'dark';
function updateThemeBtn() {
  const b = $('#themeBtn');
  const label = isDark() ? 'Switch to light mode' : 'Switch to dark mode';
  b.innerHTML = icon(isDark() ? 'sun' : 'moon');
  b.title = label;
  b.setAttribute('aria-label', label);
  // The phone's status bar, when installed as an app, matches the page.
  $('#themeColor')?.setAttribute('content', isDark() ? '#0f141a' : '#e8ecf0');
}
darkQuery.addEventListener('change', updateThemeBtn);
updateThemeBtn();

// Loads everything once signed in. Runs again after signing back in, but only sets the timers once.
let booted = false;
async function boot() {
  renderAll();
  await loadSettings();
  registerServiceWorker();
  if (state.settings && !hubConfigured()) { state.setupStep = 0; renderAll(); return startTimers(); }
  await refresh();
  loadHistory();
  startTimers();
  // Opened from the phone app's "Boost rooms" shortcut.
  if (launchAction === 'boost' && state.domain?.Room?.length) { launchAction = null; openBoostPicker(); }
}

// ---------------------------------------------------------------------------
// The phone app ("Add to Home Screen")

// Opened from the app icon or one of its long-press shortcuts: ?view=rooms, ?action=boost, and so on.
const VIEWS = ['schedules', 'rooms', 'batteries', 'diagnostics', 'settings'];
let launchAction = null;
(function readLaunchUrl() {
  const q = new URLSearchParams(location.search);
  if (!q.has('view') && !q.has('action')) return;
  if (VIEWS.includes(q.get('view'))) { state.view = q.get('view'); store.set('view', state.view); }
  if (q.get('action') === 'boost') launchAction = 'boost';
  history.replaceState(null, '', location.pathname); // so a reload doesn't repeat it
})();

// Phones only run service workers on secure (https) addresses. Inside Home Assistant, the Home
// Assistant app is the phone app, so the panel doesn't install itself there.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !isSecureContext || state.settings?.homeAssistant) return;
  navigator.serviceWorker.register('sw.js').catch(() => { /* works without it */ });
}

// Chrome, Edge and Android offer their own Install button; keep it for Settings.
let installPrompt = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  if (state.view === 'settings') renderMain();
});
addEventListener('appinstalled', () => {
  installPrompt = null;
  toast('Installed. Open it from your home screen or apps list.');
  if (state.view === 'settings') renderMain();
});
const installedApp = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = () => /android/i.test(navigator.userAgent);

async function installApp() {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
  renderMain();
}

function phonePanel(st) {
  if (st.homeAssistant) {
    return `<div class="setting"><div><b>Use the Home Assistant app</b><p>On your phone, the panel lives inside the Home Assistant app: open it, then <b>WiserHeat</b> in its sidebar. Turn on <b>Show in sidebar</b> on the app's Info page in Home Assistant if it isn't there.</p></div></div>`;
  }
  const here = `<code>${esc(location.origin + location.pathname)}</code>`;
  let how;
  if (installedApp()) {
    how = `<div class="setting"><div><b>${icon('check')} Installed</b><p>You're using the panel as an app. Long-press its icon for shortcuts to Rooms, Schedules, Boost rooms and Batteries.</p></div></div>`;
  } else if (isIOS()) {
    how = `<div class="setting"><div><b>On this iPhone or iPad</b><ol class="phone-steps">
      <li>Open this page in <b>Safari</b>.</li>
      <li>Tap the <b>Share</b> button (the square with an arrow pointing up).</li>
      <li>Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.</li></ol></div></div>`;
  } else if (installPrompt) {
    how = `<div class="setting"><div><b>Install it</b><p>Adds the panel to this device's home screen or apps list, as its own app.</p></div>
      <button class="btn primary" data-act="install-app">${icon('plus')}Install app</button></div>`;
  } else if (isAndroid() && isSecureContext) {
    how = `<div class="setting"><div><b>On this Android phone</b><ol class="phone-steps">
      <li>In Chrome, tap the <b>⋮</b> menu at the top right.</li>
      <li>Tap <b>Add to Home screen</b>, then <b>Install</b>.</li></ol></div></div>`;
  } else if (isAndroid()) {
    // Chrome only installs apps from https:// addresses; on http:// its Install option fails.
    how = `<div class="setting"><div><b>On this Android phone</b><ol class="phone-steps">
      <li>In Chrome, tap the <b>⋮</b> menu at the top right.</li>
      <li>Tap <b>Add to Home screen</b>.</li>
      <li>Choose <b>Create shortcut</b>, then <b>Add</b>. Not <b>Install</b>: on this address it says "This app cannot be installed".</li></ol>
      <p class="phone-note">The shortcut opens the panel in Chrome. Chrome only installs full apps, with their own window and offline screen, from secure <code>https://</code> addresses, and this one is <code>http://</code>. To get one, open the panel through Tailscale Serve; the README explains how.</p></div></div>`;
  } else {
    how = `<div class="setting"><div><b>On your phone</b><p>Open ${here} in your phone's browser, on your home Wi-Fi. Then, on an iPhone, tap <b>Share → Add to Home Screen</b>. On Android, tap <b>⋮ → Add to Home screen</b>${isSecureContext ? '' : ', then <b>Create shortcut</b> (this address isn\'t <code>https://</code>, so Android can\'t install it as a full app)'}. Once added, it opens straight to Rooms, and long-pressing its icon gives shortcuts.</p></div></div>`;
  }
  return how;
}

// ---------------------------------------------------------------------------
// Background refreshes, started once after the first load.

function startTimers() {
  if (booted) return;
  booted = true;
  setInterval(() => {
    if (document.hidden || state.saving) return;
    if (document.activeElement?.tagName === 'SELECT') return;
    refresh();
  }, POLL_MS);
  setInterval(loadHistory, 120_000);
  setInterval(() => { if (state.view === 'diagnostics' && !document.hidden) loadDiagnostics(); }, 60_000);
  setInterval(updateNow, 15_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}

(async function start() {
  try {
    $('#sprite').innerHTML = await (await fetch('icons.svg')).text();
  } catch { /* icons are decorative */ }
  let access = 'ok';
  try { access = (await api('GET', '/api/session')).access; } catch (e) { if (/localhost/.test(e.message)) access = 'forbidden'; }
  if (access === 'ok') boot(); else lock(access);
})();
