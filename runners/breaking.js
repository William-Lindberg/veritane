// Veritane breaking-news alerts: Android background runner (@capacitor/background-runner, official Capacitor plugin).
// Runs outside the web view on the device, about every 30 minutes (capacitor.config.ts → plugins.BackgroundRunner),
// even when the app is closed. No server, no push service, no Firebase: it downloads the public file
// https://william-lindberg.github.io/veritane/data/breaking.json from our own website and shows a local notification
// for each new entry of a kind the reader switched on, outside the reader's quiet hours.
// The reader's settings are copied here from the app (event "savePrefs", src/lib/breaking/native.ts) and kept in
// CapacitorKV on the device, with the ids already notified. Same rules as src/lib/breaking/rules.ts (toNotify);
// src/lib/breaking/breaking.test.ts runs this file against the same cases.
var DATA_URL = 'https://william-lindberg.github.io/veritane/data/breaking.json';
var KINDS = ['major_event', 'top_story', 'central_bank'];
var MAX_AGE_H = 12;
var SEEN_KEEP_DAYS = 3;
var SEEN_MAX = 300;
var HOUR = 3600000;
var ID_RE = /^[a-z0-9][a-z0-9-]{2,80}$/;
var PATH_RE = /^news\/[A-Za-z0-9/?=._%-]*$/;
var TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
var TITLES = {
  en: { major_event: 'Breaking: world news', top_story: 'Breaking: economic news', central_bank: 'Central bank decision' },
  sv: { major_event: 'Senaste nytt: världen', top_story: 'Senaste nytt: ekonomi', central_bank: 'Centralbanksbeslut' },
};

function kvGet(key, fallback) {
  try {
    var r = CapacitorKV.get(key);
    var v = r && typeof r === 'object' ? r.value : r;
    return v ? JSON.parse(v) : fallback;
  } catch (e) { return fallback; }
}
function kvSet(key, value) { try { CapacitorKV.set(key, JSON.stringify(value)); } catch (e) { /* ignore */ } }

function mins(hhmm) { var m = TIME_RE.exec(hhmm || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; }
function inQuiet(q, local) {
  if (!q || !q.on) return false;
  var from = mins(q.from), to = mins(q.to);
  if (from === to) return false;
  return from < to ? local >= from && local < to : local >= from || local < to;
}
function notificationId(id) {
  var h = 0x811c9dc5;
  for (var i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return 1000000000 + (h % 1000000000);
}
function validEntry(e) {
  return !!e && typeof e === 'object' && ID_RE.test(e.id || '') && isFinite(Date.parse(e.time || '')) && KINDS.indexOf(e.kind) > -1
    && typeof e.headline === 'string' && !!e.headline.trim() && typeof e.path === 'string' && PATH_RE.test(e.path) && e.path.indexOf('..') < 0;
}

/** Pure decision (exported for the tests through the global object). `local` = minutes after local midnight. */
function decide(file, settings, seen, nowMs, local) {
  var prefs = settings && settings.prefs;
  if (!prefs || !prefs.notify || !KINDS.some(function (k) { return prefs.notify[k] === true; })) return [];
  if (inQuiet(prefs.quiet, local)) return [];
  if (!file || file.schema !== 'veritane/breaking/1' || !Array.isArray(file.entries)) return [];
  var done = {};
  (seen || []).forEach(function (s) { done[s[0]] = true; });
  return file.entries.filter(function (e) {
    if (!validEntry(e) || prefs.notify[e.kind] !== true || done[e.id]) return false;
    var at = Date.parse(e.time);
    return at <= nowMs + HOUR && nowMs - at <= MAX_AGE_H * HOUR;
  }).sort(function (a, b) { return a.time < b.time ? -1 : a.time > b.time ? 1 : a.id < b.id ? -1 : 1; });
}
function markSeen(seen, ids, nowMs) {
  var cut = nowMs - SEEN_KEEP_DAYS * 24 * HOUR;
  var at = new Date(nowMs).toISOString();
  var have = {};
  var next = (seen || []).filter(function (s) { return Date.parse(s[1]) >= cut; });
  next.forEach(function (s) { have[s[0]] = true; });
  ids.forEach(function (id) { if (!have[id]) next.push([id, at]); });
  return next.slice(-SEEN_MAX);
}
function localMinutes(nowMs, settings) {
  var offset = settings && typeof settings.tzOffset === 'number' ? settings.tzOffset : new Date(nowMs).getTimezoneOffset();
  return (((Math.floor(nowMs / 60000) - offset) % 1440) + 1440) % 1440;
}
globalThis.__veritaneBreaking = { decide: decide, markSeen: markSeen, notificationId: notificationId, localMinutes: localMinutes, inQuiet: inQuiet };

// The app copies the reader's settings here whenever they change (and on every app start).
addEventListener('savePrefs', function (resolve, reject, args) {
  try {
    var d = (args && args.settings) || {};
    kvSet('prefs', { prefs: d.prefs || null, tzOffset: typeof d.tzOffset === 'number' ? d.tzOffset : 0, lang: d.lang === 'sv' ? 'sv' : 'en' });
    if (d.resetSeen === true) kvSet('seen', []);
    resolve();
  } catch (e) { reject(e); }
});

// Mark entries the app already notified or showed (the app sends their ids), so the runner does not repeat them.
addEventListener('markSeen', function (resolve, reject, args) {
  try { kvSet('seen', markSeen(kvGet('seen', []), (args && args.ids) || [], Date.now())); resolve(); } catch (e) { reject(e); }
});

// Which page belongs to a notification the reader tapped (the app asks with the notification id).
addEventListener('pathFor', function (resolve, reject, args) {
  try { var map = kvGet('paths', {}); resolve({ path: map[String(args && args.id)] || null }); } catch (e) { reject(e); }
});

// The periodic check (event name in capacitor.config.ts).
addEventListener('checkBreaking', function (resolve, reject) {
  var settings = kvGet('prefs', null);
  if (!settings || !settings.prefs) { resolve(); return; }
  var now = Date.now();
  var local = localMinutes(now, settings);
  if (!KINDS.some(function (k) { return settings.prefs.notify && settings.prefs.notify[k] === true; }) || inQuiet(settings.prefs.quiet, local)) { resolve(); return; }
  fetch(DATA_URL, { headers: { Accept: 'application/json' } })
    .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
    .then(function (file) {
      var seen = kvGet('seen', []);
      var list = decide(file, settings, seen, now, local).slice(-3);
      if (list.length) {
        var titles = TITLES[settings.lang] || TITLES.en;
        var paths = kvGet('paths', {});
        CapacitorNotifications.schedule(list.map(function (e) {
          var id = notificationId(e.id);
          paths[String(id)] = e.path;
          return { id: id, title: titles[e.kind], body: e.headline, largeBody: e.headline, smallIcon: 'ic_stat_veritane', autoCancel: true, extra: { path: e.path } };
        }));
        var keys = Object.keys(paths);
        if (keys.length > 60) keys.slice(0, keys.length - 60).forEach(function (k) { delete paths[k]; });
        kvSet('paths', paths);
      }
      // Entries that were skipped as too old count as seen too, so they never arrive late.
      var all = (file && Array.isArray(file.entries) ? file.entries : []).filter(validEntry).map(function (e) { return e.id; });
      kvSet('seen', markSeen(seen, list.map(function (e) { return e.id; }).concat(all.filter(function (id) {
        var e = file.entries.filter(function (x) { return x.id === id; })[0];
        return settings.prefs.notify[e.kind] === true && now - Date.parse(e.time) > MAX_AGE_H * HOUR;
      })), now));
      resolve();
    })
    .catch(function () { resolve(); });
});
