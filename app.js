/* 驚喜製造機 app.js (MP3 優先 + 行政區保底引擎 + 動態倒數) */

// ★ 填入你的 GAS 網址
const API_URL = 'https://script.google.com/macros/s/AKfycbwdOJ2Cve8l2c5WAq65KyyvnpXarwo9N3oDoLhhAFRiRzAMKWh5Q6-nTTXu1W0MWFPABA/exec';
const AUDIO_DIR = 'audio';
const COOLDOWN_MS = 3 * 60 * 1000;   // 冷知識冷卻：3 分鐘
const QUIET_MS = 10 * 60 * 1000;     // 大保底冷卻：10 分鐘

// 💡 新增：依據題型動態設定思考倒數時間 (毫秒)
// pois (景點有選項) -> 15秒, facts/region (冷知識無選項) -> 10秒
const WAIT_MS = { pois: 15000, facts: 10000, region: 10000 };

// 行政區圖資屬性設定
const COUNTY_KEYS = ['COUNTYNAME', 'countyName', 'county'];
const TOWN_KEYS = ['TOWNNAME', 'townName', 'town', 'name'];

const VOICE_KEYS = ['Premium', 'Enhanced', 'Siri', 'Natural', 'Neural', 'Online', 'Google', 'Ting-Ting', 'Mei-Jia'];
const VOICE_PREF = 'voice_pref';
const KEY = { pois: 'played_pois', facts: 'played_facts', region: 'played_region', cache: 'offline_cache' };

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => { $('log').textContent = m; };
const ui = (id, text, state = '') => { const el = $(id); el.textContent = text; el.dataset.s = state; };

let db = { pois: [], facts: [], regionFacts: [] };
let isBroadcasting = false, lastEnd = 0, startedAt = 0;
let bestVoice = null, voice = null, watchId = null, wakeLock = null, audioCtx = null, started = false;
let districts = [], here = null, hereAt = null; 
window.speechUtterances = [];

const ttsAudio = new Audio();
ttsAudio.preload = 'auto';

/* ---------- LocalStorage ---------- */
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
const played = type => new Set(store.get(KEY[type], []));
const markPlayed = (type, name) => { const s = played(type); s.add(name); store.set(KEY[type], [...s]); };

/* ---------- 載入圖資與題庫 ---------- */
async function loadDistricts() {
  try {
    const gj = await (await fetch('districts.geojson')).json();
    districts = gj.features.map(f => {
      const g = f.geometry, polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
      let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
      polys.forEach(p => p[0].forEach(([x, y]) => { x0=Math.min(x0,x); x1=Math.max(x1,x); y0=Math.min(y0,y); y1=Math.max(y1,y); }));
      const norm = s => String(s || '').replace(/台/g, '臺').trim();
      const pickKey = keys => { for (const k of keys) if (f.properties && f.properties[k]) return String(f.properties[k]); return ''; };
      return { county: norm(pickKey(COUNTY_KEYS)), town: norm(pickKey(TOWN_KEYS)), bbox: [x0, y0, x1, y1], polys };
    });
  } catch (e) { log('未載入行政區圖資'); districts = []; }
}

async function loadDB() {
  try {
    const res = await fetch(API_URL);
    const json = await res.json();
    if (json.status !== 'success') throw new Error(json.message);
    db = { pois: json.data.pois || [], facts: json.data.facts || [], regionFacts: json.data.regionFacts || [] };
    store.set(KEY.cache, db);
    ui('dbStatus', `線上 ✓ 主線 ${db.pois.length}／冷知識 ${db.facts.length}／行政區 ${db.regionFacts.length}`);
  } catch (e) {
    const cache = store.get(KEY.cache, null);
    if (cache) {
      db = { pois: cache.pois || [], facts: cache.facts || [], regionFacts: cache.regionFacts || [] };
      ui('dbStatus', `離線備援 ✓`, 'warn');
    } else { ui('dbStatus', '載入失敗', 'err'); }
  }
}

/* ---------- 語音解鎖與備援 ---------- */
function initVoices() {
  if (!('speechSynthesis' in window)) return;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return;
  const tw = voices.filter(v => /(zh|cmn)[-_]TW/i.test(v.lang));
  if (tw.length) bestVoice = tw.sort((a, b) => {
    let sA = 0, sB = 0;
    VOICE_KEYS.forEach((k, i) => { if(a.name.includes(k)) sA+=100-i; if(b.name.includes(k)) sB+=100-i; });
    return sB - sA;
  })[0] || tw[0];
}
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = initVoices;

async function unlockMedia() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();
  } catch {}
  try {
    const u = new SpeechSynthesisUtterance(' '); u.volume = 0;
    speechSynthesis.speak(u); setTimeout(initVoices, 100);
  } catch {}
  try {
    ttsAudio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
    await ttsAudio.play(); ttsAudio.pause();
  } catch {}
  await Promise.all([$('chime'),$('countdown')].map(a => {
    a.muted = true;
    return a.play().then(() => { a.pause(); a.currentTime = 0; }).catch(() => {}).finally(() => { a.muted = false; });
  }));
}

async function lockScreen() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}

/* ---------- 播放引擎 (MP3 優先) ---------- */
function playAudio(el, loop = false) { el.loop = loop; el.currentTime = 0; return el.play().catch(()=>{}); }

function speak(text) {
  return new Promise(resolve => {
    if (!('speechSynthesis' in window)) return resolve();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (bestVoice) u.voice = bestVoice;
    u.lang = 'zh-TW'; u.rate = 0.92; u.pitch = 1.05;
    window.speechUtterances.push(u);
    const done = () => { clearTimeout(guard); window.speechUtterances = window.speechUtterances.filter(x => x !== u); resolve(); };
    const guard = setTimeout(done, text.length * 500 + 8000);
    u.onend = done; u.onerror = done;
    speechSynthesis.speak(u);
  });
}

function playMp3OrSpeak(itemName, part, fallbackText) {
  return new Promise(resolve => {
    const mp3Url = `${AUDIO_DIR}/${encodeURIComponent(String(itemName).trim())}_${part}.mp3`;
    let fell = false;
    const fallback = async () => {
      if (fell) return; fell = true;
      ttsAudio.onended = ttsAudio.onerror = ttsAudio.onloadeddata = null;
      ui('broadcastStatus', `🗣️ 內建語音：${itemName}`, 'warn');
      try { await speak(fallbackText); } catch {} finally { resolve(); }
    };
    ttsAudio.onloadeddata = () => { ui('broadcastStatus', `🔊 MP3 播報：${itemName}`, 'warn'); };
    ttsAudio.onended = () => { ttsAudio.onloadeddata = null; ttsAudio.onended = null; ttsAudio.onerror = null; resolve(); };
    ttsAudio.onerror = fallback;
    ttsAudio.src = mp3Url;
    ttsAudio.play().catch(fallback);
  });
}

const clean = s => String(s).replace(/^[A-Cabc][.、\s]+/i, '').trim();

async function broadcast(item, type) {
  if (isBroadcasting) return;
  isBroadcasting = true;
  markPlayed(type, item.name);
  ui('broadcastStatus', `準備播報：${item.name}`, 'warn');
  
  try {
    // 1. 播放開場提示音 (chime.mp3)
    await playAudio($('chime')); await sleep(2000);

    let qText = item.question || '';
    if (type === 'pois') {
      const labels = ['A', 'B', 'C'];
      const rawOpts = item.options || [item.optionA, item.optionB, item.optionC].filter(Boolean);
      const opts = rawOpts.map((o, i) => `選項${labels[i]}，${clean(o)}`).join('。');
      qText = `${item.question}。${opts}。`;
    }
    await playMp3OrSpeak(item.name, 'q', qText);

    // 💡 2. 動態抓取等待秒數並播放倒數背景音 (countdown.mp3)
    const waitTime = WAIT_MS[type] || 15000;
    ui('broadcastStatus', `⏳ 思考倒數 ${waitTime / 1000} 秒`, 'warn');
    await playAudio($('countdown'), true); 
    await sleep(waitTime); 
    $('countdown').pause();

    // 3. 播報解答
    await playMp3OrSpeak(item.name, 'a', item.answer || '');
  } catch (e) { log('播報中斷'); } 
  finally {
    $('countdown').pause(); isBroadcasting = false; lastEnd = Date.now();
    ui('broadcastStatus', '待命');
  }
}

/* ---------- 行政區與 GPS 判斷 ---------- */
function inRing(x, y, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const inPoly = (x, y, poly) => inRing(x, y, poly[0]) && !poly.slice(1).some(h => inRing(x, y, h));
const locate = (lat, lng) => districts.find(d => lng >= d.bbox[0] && lng <= d.bbox[2] && lat >= d.bbox[1] && lat <= d.bbox[3] && d.polys.some(p => inPoly(lng, lat, p))) || null;

const norm = s => String(s || '').replace(/台/g, '臺').trim();
function pickRegion(h) {
  const done = played('region'), un = db.regionFacts.filter(f => !done.has(f.name));
  return un.find(f => f.town && norm(f.town) === h.town && norm(f.county) === h.county) || un.find(f => !f.town && f.county && norm(f.county) === h.county) || null;
}
const pickGeneric = () => { const done = played('region'); return db.regionFacts.find(f => !f.county && !f.town && !done.has(f.name)) || null; };

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371, rad = d => d * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const fmtDist = d => d < 1 ? `${Math.round(d * 1000)} 公尺` : `${d.toFixed(1)} 公里`;

function startGPS() {
  if (!navigator.geolocation) return ui('gpsStatus', '此裝置不支援定位', 'err');
  if (watchId !== null) return;
  ui('gpsStatus', '定位中…', 'warn');
  watchId = navigator.geolocation.watchPosition(onPosition, e => ui('gpsStatus', '定位失敗', 'err'), { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 });
}

function onPosition(pos) {
  const { latitude: lat, longitude: lng, accuracy } = pos.coords;
  const now = Date.now();

  // 判斷目前行政區 (移動超過 300 公尺才重算)
  if (districts.length && (!hereAt || haversine(hereAt.lat, hereAt.lng, lat, lng) > 0.3)) {
    here = locate(lat, lng);
    hereAt = { lat, lng };
  }
  ui('gpsStatus', `已定位 ±${Math.round(accuracy)} 公尺${here ? '・' + here.county + here.town : ''}`);

  const rank = (list, done) => list.filter(i => !done.has(i.name)).map(i => ({ i, d: haversine(lat, lng, i.lat, i.lng) })).sort((a, b) => a.d - b.d);
  const poiRank = rank(db.pois, played('pois'));
  $('nextDist').textContent = poiRank.length ? fmtDist(poiRank[0].d) : '主線已全數播完';

  if (isBroadcasting) return;

  // 優先級 1：主線景點
  const poiHit = poiRank.find(x => x.d <= (x.i.radius || 1.0));
  if (poiHit) return broadcast(poiHit.i, 'pois');

  // 優先級 2：點位冷知識 (需過 3 分鐘冷卻)
  if (now - lastEnd < COOLDOWN_MS) return;
  const factHit = rank(db.facts, played('facts')).find(x => x.d <= (x.i.radius || 5.0));
  if (factHit) return broadcast(factHit.i, 'facts');

  // 優先級 3：行政區冷知識保底
  if (here) { const r = pickRegion(here); if (r) return broadcast(r, 'region'); }

  // 優先級 4：全域超級大保底 (需過 10 分鐘冷卻)
  if (now - Math.max(lastEnd, startedAt) >= QUIET_MS) { const g = pickGeneric(); if (g) broadcast(g, 'region'); }
}

/* ---------- 按鈕 ---------- */
$('btnStart').addEventListener('click', async () => {
  if (started) return; started = true; startedAt = Date.now();
  $('btnStart').disabled = true; $('btnStart').textContent = '系統運行中';
  await Promise.all([unlockMedia(), lockScreen()]);
  if (!db.pois.length) await loadDB();
  startGPS();
});

$('btnTest').addEventListener('click', async () => {
  if (isBroadcasting) return; await unlockMedia();
  if (!db.pois.length) await loadDB();
  
  // 💡 修改測試邏輯，測試時優先隨機播放一題「點位冷知識」來驗證 10 秒倒數
  const doneFacts = played('facts');
  const poolFacts = db.facts.filter(p => !doneFacts.has(p.name));
  
  if (poolFacts.length > 0) {
    broadcast(poolFacts[Math.floor(Math.random() * poolFacts.length)], 'facts');
  } else {
    // 找不到冷知識就退回播放景點
    const donePois = played('pois'), poolPois = db.pois.filter(p => !donePois.has(p.name));
    const target = poolPois.length ? poolPois[0] : db.pois[0];
    if (target) broadcast(target, 'pois');
  }
});

$('btnReset').addEventListener('click', () => {
  if (!confirm('確定要清空播報進度？')) return;
  ttsAudio.pause(); if ('speechSynthesis' in window) speechSynthesis.cancel();
  localStorage.clear(); store.set(KEY.cache, db); lastEnd = 0;
  log('進度已重置');
});

loadDB();
loadDistricts();