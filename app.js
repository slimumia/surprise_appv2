/* 驚喜製造機 app.js (支援 YunJhe MP3 優先播放 + 內建 TTS 自動備援) */

// ★ 貼上 Code.gs 部署後的「網頁應用程式網址」（結尾為 /exec）
const API_URL = 'https://script.google.com/macros/s/AKfycbwdOJ2Cve8l2c5WAq65KyyvnpXarwo9N3oDoLhhAFRiRzAMKWh5Q6-nTTXu1W0MWFPABA/exec';

const AUDIO_DIR = 'audio';           // 存放預錄 MP3 的資料夾名稱
const COOLDOWN_MS = 3 * 60 * 1000;   // 冷知識冷卻：上一次播報結束後 3 分鐘
const COUNTDOWN_MS = 15 * 1000;      // 思考倒數 15 秒
// 越前面權重越高；涵蓋 Apple（Premium/Enhanced/Siri/Mei-Jia）、Edge（Natural/Online）、Chrome（Google 網路語音）
const VOICE_KEYS = ['Premium', 'Enhanced', 'Siri', 'Natural', 'Neural', 'Online', 'Google', 'Ting-Ting', 'Mei-Jia', 'Meijia', '美佳', '臺灣', '台灣'];
const VOICE_PREF = 'voice_pref';     // 使用者手動鎖定的語音（voiceURI）
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

// 專用預錄 MP3 語音播放器
const ttsAudio = new Audio();
ttsAudio.preload = 'auto';

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
    
    // 自動相容單一陣列或 { pois, facts } 雙工作表結構
    if (Array.isArray(json.data)) {
      db = { pois: json.data, facts: [] };
    } else {
      db = { pois: json.data.pois || [], facts: json.data.facts || [] };
    }
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

/* ---------- 高音質語音鎖定（作為無 MP3 時的備援語音）---------- */
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
  const pool = tw.length ? tw : all.filter(v => /^(zh|cmn)/i.test(v.lang));
  const saved = store.get(VOICE_PREF, null);
  voice = all.find(v => v.voiceURI === saved)
    || [...pool].sort((a, b) => scoreVoice(b) - scoreVoice(a))[0] || null;
  fillVoiceList(pool.length ? pool : all);
  log(voice ? `備援語音：${voice.name}（優先播放預錄 MP3）` : '優先播放預錄 MP3（無中文備援語音）');
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

  // 解鎖预錄 MP3 播放器 (ttsAudio) 與背景音效 (chime, countdown)
  try {
    ttsAudio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
    await ttsAudio.play();
    ttsAudio.pause();
  } catch { /* 忽略初始解鎖錯誤 */ }

  await Promise.all([$('chime'),$('countdown')].map(a => {
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
  if (started && document.visibilityState === 'visible') lockScreen();
});

/* ---------- 音效 / MP3 優先播報 / TTS 備援 ---------- */
function playAudio(el, loop = false) {
  el.loop = loop;
  el.currentTime = 0;
  return el.play().catch(() => {});
}

function speak(text) {
  return new Promise(resolve => {
    const u = new SpeechSynthesisUtterance(text);
    if (!voice) pickVoice();
    u.lang = voice ? voice.lang : 'zh-TW';
    if (voice) u.voice = voice;
    u.rate = 0.92;
    u.pitch = 1.05;
    window.speechUtterances.push(u);
    const done = () => {
      clearTimeout(guard);
      window.speechUtterances = window.speechUtterances.filter(x => x !== u);
      resolve();
    };
    const guard = setTimeout(done, text.length * 500 + 8000);
    u.onend = done;
    u.onerror = done;
    speechSynthesis.speak(u);
  });
}

// ★ 核心雙軌播放：優先尋找 audio/<名稱>_<q|a>.mp3，若無檔案則自動切換為 speak() 備援
function playMp3OrSpeak(itemName, part, fallbackText) {
  return new Promise(resolve => {
    const fileName = `${ String(itemName).trim() }_${part}.mp3`;
    const mp3Url = `${AUDIO_DIR}/${encodeURIComponent(String(itemName).trim())}_${part}.mp3`;

    const cleanup = () => {
      ttsAudio.onloadeddata = null;
      ttsAudio.onended = null;
      ttsAudio.onerror = null;
    };

    const fallbackToTTS = async () => {
      cleanup();
      ui('broadcastStatus', `🗣️ 內建語音：${itemName}`, 'warn');
      log(`未找到 ${fileName}，已自動切換為內建語音備援`);
      await speak(fallbackText);
      resolve();
    };

    ttsAudio.onloadeddata = () => {
      ui('broadcastStatus', `🔊 MP3 播報：${itemName}`, 'warn');
      log(`正在播放預錄音檔：${fileName}`);
    };

    ttsAudio.onended = () => {
      cleanup();
      resolve();
    };

    ttsAudio.onerror = fallbackToTTS;

    ttsAudio.src = mp3Url;
    ttsAudio.play().catch(fallbackToTTS);
  });
}

// 移除選項開頭的 A. / B、/ c 等字母標籤
const clean = s => String(s).replace(/^[A-Cabc][.、\s]+/i, '').trim();

/* ---------- 沉浸式廣播劇流程 ---------- */
async function broadcast(item, type) {
  if (isBroadcasting) return;
  isBroadcasting = true;                 // 同步上鎖，先於任何 await
  markPlayed(type, item.name);
  ui('broadcastStatus', type === 'pois' ? `準備播報：${item.name}` : `準備播報：${item.name}`, 'warn');
  try {
    // 1. 開場提示音 + 等待 2 秒
    await playAudio($('chime'));
    await sleep(2000);

    // 2. 播報題目（優先播 _q.mp3，若無則念文字）
    let questionText = item.question || '';
    if (type === 'pois') {
      const labels = ['A', 'B', 'C'];
      const rawOpts = item.options || [item.optionA, item.optionB, item.optionC].filter(Boolean);
      const opts = rawOpts.map((o, i) => `選項${labels[i]}，${clean(o)}`).join('。');
      questionText = `${item.question}。${opts}。`;
    }
    await playMp3OrSpeak(item.name, 'q', questionText);

    // 3. 15 秒思考倒數
    ui('broadcastStatus', `⏳ 思考倒數 15 秒：${item.name}`, 'warn');
    await playAudio($('countdown'), true);
    await sleep(COUNTDOWN_MS);
    $('countdown').pause();

    // 4. 播報解答（優先播 _a.mp3，若無則念文字）
    await playMp3OrSpeak(item.name, 'a', item.answer || '');
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
  const poiHit = poiRank.find(x => x.d <= (x.i.radius || 1.0));
  if (poiHit) return broadcast(poiHit.i, 'pois');

  // 優先級 2：冷知識，需通過 3 分鐘冷卻
  if (Date.now() - lastEnd < COOLDOWN_MS) return;
  const factHit = rank(db.facts, played('facts')).find(x => x.d <= (x.i.radius || 5.0));
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
  if (!db.pois.length) await loadDB();
  const done = played('pois');
  const pool = db.pois.filter(p => !done.has(p.name));
  // 優先依序選取第 1 個未播報的景點（確保能直接測到第 1 題的 MP3）；若全數播完則直接測第 1 題
  const target = pool.length ? pool[0] : db.pois[0];
  if (!target) return log('題庫目前沒有任何景點資料');
  broadcast(target, 'pois');
}

function resetProgress() {
  if (!confirm('確定要清空播報進度？')) return;
  ttsAudio.pause();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  const pref = store.get(VOICE_PREF, null);
  localStorage.clear();
  store.set(KEY.cache, db);   // 清空後立刻補回題庫備援，避免斷線時沒有資料
  if (pref) store.set(VOICE_PREF, pref);   // 保留手動鎖定的語音
  lastEnd = 0;
  log('播報進度已重置，下次測試將從第 1 題開始');
}

/* ---------- 初始化 ---------- */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if ('speechSynthesis' in window) { speechSynthesis.onvoiceschanged = pickVoice; pickVoice(); }
$('btnStart').addEventListener('click', startSystem);$('btnTest').addEventListener('click', testBroadcast);
$('btnReset').addEventListener('click', resetProgress);$('voiceSelect').addEventListener('change', e => {
  const picked = speechSynthesis.getVoices().find(v => v.voiceURI === e.target.value);
  if (!picked) return;
  voice = picked;
  store.set(VOICE_PREF, picked.voiceURI);
  log(`已鎖定備援語音：${picked.name}`);
  if (!isBroadcasting) { speechSynthesis.cancel(); speak('前方一公里有驚喜，準備好了嗎？'); }
});
loadDB();