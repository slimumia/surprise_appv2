/* 驚喜製造機 app.js */

// ★ 貼上 Code.gs 部署後的「網頁應用程式網址」（結尾為 /exec）
const API_URL = 'https://script.google.com/macros/s/XXXXXXXX/exec';

const COOLDOWN_MS = 3 * 60 * 1000;   // 冷知識冷卻：上一次播報結束後 3 分鐘
const COUNTDOWN_MS = 15 * 1000;      // 思考倒數 15 秒
// 越前面權重越高；涵蓋 Apple（Premium/Enhanced/Siri/Mei-Jia）、Edge（Natural/Online）、Chrome（Google 網路語音）
const VOICE_KEYS = ['Premium', 'Enhanced', 'Siri', 'Natural', 'Neural', 'Online', 'Google', 'Ting-Ting', 'Mei-Jia', 'Meijia', '美佳', '臺灣', '台灣'];
const VOICE_PREF = 'voice_pref';   // 使用者手動鎖定的語音（voiceURI）
const KEY = { pois: 'played_pois', facts: 'played_facts', cache: 'offline_cache' };

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => { $('log').textContent = m; };
const ui = (id, text, state = '') => { const el = $(id); el.textContent = text; el.dataset.s = state; };

let db = { pois: [], facts: [] };
let isBroadcasting = false;   // 播報鎖，防止多重觸發
let lastEnd = 0;              // 上一次播報結束時間
let voice = null, watchId = null, wakeLock = null, audioCtx = null, started = false;
window.speechUtterances = []; // 防止長文字被垃圾回收而中斷

/* ---------- LocalStorage ---------- */
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 容量滿或無痕模式 */ } }
};
const played = type => new Set(store.get(KEY[type], []));
const markPlayed = (type, name) => { const s = played(type); s.add(name); store.set(KEY[type], [...s]); };

/* ---------- 題庫載入（線上優先，失敗用 offline_cache）---------- */
async function loadDB() {
  try {
    if (!API_URL || API_URL.includes('XXXX')) throw new Error('尚未設定 API_URL');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    const res = await fetch(API_URL, { signal: ctl.signal });
    clearTimeout(timer);
    const json = await res.json();
    if (json.status !== 'success') throw new Error(json.message || 'API 錯誤');
    db = { pois: json.data.pois || [], facts: json.data.facts || [] };
    store.set(KEY.cache, db);
    ui('dbStatus', `線上 ✓ 景點 ${db.pois.length}／冷知識 ${db.facts.length}`);
  } catch (e) {
    const cache = store.get(KEY.cache, null);
    if (cache) {
      db = { pois: cache.pois || [], facts: cache.facts || [] };
      ui('dbStatus', `離線備援 景點 ${db.pois.length}／冷知識 ${db.facts.length}`, 'warn');
    } else {
      ui('dbStatus', '載入失敗：' + e.message, 'err');
    }
  }
}

/* ---------- 高音質語音鎖定 ---------- */
function scoreVoice(v) {
  let s = 0;
  VOICE_KEYS.forEach((k, i) => { if (v.name.includes(k)) s += 100 - i; });
  if (/compact/i.test(v.voiceURI)) s -= 50;  // iOS 精簡版音質最差
  if (!v.localService) s += 20;              // 網路語音通常較自然
  return s;
}

function fillVoiceList(list) {
  const sel = $('voiceSelect');
  sel.innerHTML = '';
  list.forEach(v => sel.add(new Option(`${v.name}（${v.lang}）`, v.voiceURI, false, v === voice)));
}

function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const all = speechSynthesis.getVoices();
  if (!all.length) return;                   // 語音清單尚未載入，等 onvoiceschanged
  const tw = all.filter(v => /(zh|cmn)[-_]TW/i.test(v.lang));
  const pool = tw.length ? tw : all.filter(v => /^(zh|cmn)/i.test(v.lang)); // 沒有台灣語音才退到其他中文
  const saved = store.get(VOICE_PREF, null);
  voice = all.find(v => v.voiceURI === saved)
    || [...pool].sort((a, b) => scoreVoice(b) - scoreVoice(a))[0] || null;
  fillVoiceList(pool.length ? pool : all);
  log(voice ? `語音：${voice.name}（${voice.lang}）` : '找不到中文語音，使用系統預設');
}

/* ---------- 解鎖音訊 / 語音 / 螢幕常亮（必須在點擊事件中呼叫）---------- */
async function unlockMedia() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const resume = audioCtx.resume();
    const src = audioCtx.createBufferSource();
    src.buffer = audioCtx.createBuffer(1, 1, 22050);
    src.connect(audioCtx.destination);
    src.start(0);
    await resume;
  } catch { /* 不支援 Web Audio */ }

  try { // 靜音語音一次，解鎖 Web Speech API
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    window.speechUtterances.push(u);
    speechSynthesis.speak(u);
  } catch { /* 不支援 TTS */ }

  await Promise.all([$('chime'), $('countdown')].map(a => {
    a.muted = true;
    return a.play().then(() => { a.pause(); a.currentTime = 0; }).catch(() => {}).finally(() => { a.muted = false; });
  }));
  pickVoice();
}

async function lockScreen() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) { log('螢幕常亮失敗：' + e.message); }
}
document.addEventListener('visibilitychange', () => {
  if (started && document.visibilityState === 'visible') lockScreen(); // 切回 App 時重新申請
});

/* ---------- 音效 / TTS ---------- */
function playAudio(el, loop = false) {
  el.loop = loop;
  el.currentTime = 0;
  return el.play().catch(() => {});
}

function speak(text) {
  return new Promise(resolve => {
    const u = new SpeechSynthesisUtterance(text);
    if (!voice) pickVoice();                 // 語音可能在首次播報後才載入
    u.lang = voice ? voice.lang : 'zh-TW';   // lang 與 voice 一致，避免部分瀏覽器被切回系統預設語音
    if (voice) u.voice = voice;
    u.rate = 0.92;
    u.pitch = 1.05;
    window.speechUtterances.push(u);
    const done = () => {
      clearTimeout(guard);
      window.speechUtterances = window.speechUtterances.filter(x => x !== u);
      resolve();
    };
    const guard = setTimeout(done, text.length * 500 + 8000); // 瀏覽器漏發 onend 時的保險
    u.onend = done;
    u.onerror = done;
    speechSynthesis.speak(u);
  });
}

// 移除選項開頭的 A. / B、/ c 等字母標籤
const clean = s => String(s).replace(/^[A-Cabc][.、\s]+/i, '').trim();

/* ---------- 沉浸式廣播劇流程 ---------- */
async function broadcast(item, type) {
  if (isBroadcasting) return;
  isBroadcasting = true;                 // 同步上鎖，先於任何 await
  markPlayed(type, item.name);
  ui('broadcastStatus', type === 'pois' ? `播報中：${item.name}` : '播報中：冷知識', 'warn');
  try {
    await playAudio($('chime'));
    await sleep(2000);

    if (type === 'pois') {
      const labels = ['A', 'B', 'C'];
      const opts = (item.options || []).map((o, i) => `選項${labels[i]}，${clean(o)}`).join('。');
      await speak(`${item.question}。${opts}。`);
    } else {
      await speak(item.question);        // 冷知識：直接念破冰問句
    }

    await playAudio($('countdown'), true); // 15 秒倒數音效
    await sleep(COUNTDOWN_MS);
    $('countdown').pause();

    await speak(item.answer);   // 解答文本本身已以「答案是…」開頭
  } catch (e) {
    log('播報中斷：' + e.message);
  } finally {
    $('countdown').pause();
    isBroadcasting = false;
    lastEnd = Date.now();                // 冷卻從「播報結束」開始算
    ui('broadcastStatus', '待命');
  }
}

/* ---------- GPS ---------- */
function haversine(lat1, lng1, lat2, lng2) { // 回傳公里
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
  watchId = navigator.geolocation.watchPosition(onPosition,
    e => ui('gpsStatus', ({ 1: '定位權限被拒絕', 2: '無法取得位置', 3: '定位逾時' })[e.code] || e.message, 'err'),
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 });
}

function onPosition(pos) {
  const { latitude: lat, longitude: lng, accuracy } = pos.coords;
  ui('gpsStatus', `已定位 ±${Math.round(accuracy)} 公尺`);

  const rank = (list, done) => list
    .filter(i => !done.has(i.name))
    .map(i => ({ i, d: haversine(lat, lng, i.lat, i.lng) }))
    .sort((a, b) => a.d - b.d);

  const poiRank = rank(db.pois, played('pois'));
  $('nextDist').textContent = poiRank.length ? fmtDist(poiRank[0].d) : '主線已全數播完';

  if (isBroadcasting) return;

  // 優先級 1：主線景點，進入專屬半徑立即觸發
  const poiHit = poiRank.find(x => x.d <= x.i.radius);
  if (poiHit) return broadcast(poiHit.i, 'pois');

  // 優先級 2：冷知識，需通過 3 分鐘冷卻
  if (Date.now() - lastEnd < COOLDOWN_MS) return;
  const factHit = rank(db.facts, played('facts')).find(x => x.d <= x.i.radius);
  if (factHit) broadcast(factHit.i, 'facts');
}

/* ---------- 按鈕 ---------- */
async function startSystem() {
  if (started) return;
  started = true;
  $('btnStart').disabled = true;
  $('btnStart').textContent = '系統運行中';
  await Promise.all([unlockMedia(), lockScreen()]);
  if (!db.pois.length && !db.facts.length) await loadDB();
  startGPS();
}

async function testBroadcast() {
  if (isBroadcasting) return;
  await unlockMedia();
  const done = played('pois');
  const pool = db.pois.filter(p => !done.has(p.name));
  if (!pool.length) return log('沒有未播報的主線景點，請先重置播報進度');
  broadcast(pool[Math.floor(Math.random() * pool.length)], 'pois');
}

function resetProgress() {
  if (!confirm('確定要清空播報進度？')) return;
  const pref = store.get(VOICE_PREF, null);
  localStorage.clear();
  store.set(KEY.cache, db);   // 清空後立刻補回題庫備援，避免斷線時沒有資料
  if (pref) store.set(VOICE_PREF, pref);   // 保留手動鎖定的語音
  lastEnd = 0;
  log('播報進度已重置');
}

/* ---------- 初始化 ---------- */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if ('speechSynthesis' in window) { speechSynthesis.onvoiceschanged = pickVoice; pickVoice(); }
$('btnStart').addEventListener('click', startSystem);
$('btnTest').addEventListener('click', testBroadcast);
$('btnReset').addEventListener('click', resetProgress);
$('voiceSelect').addEventListener('change', e => {
  const picked = speechSynthesis.getVoices().find(v => v.voiceURI === e.target.value);
  if (!picked) return;
  voice = picked;
  store.set(VOICE_PREF, picked.voiceURI);
  log(`已鎖定語音：${picked.name}`);
  if (!isBroadcasting) { speechSynthesis.cancel(); speak('前方一公里有驚喜，準備好了嗎？'); } // 試聽
});
loadDB();
