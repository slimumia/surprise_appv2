/**
 * 驚喜製造機 - Google Apps Script 後端 API
 *
 * ===== 如何部署 GAS API 網址 =====
 * 1. 開啟你的 Google Sheets（需有「questionsData」與「TripFacts」兩個工作表）
 * 2. 選單「擴充功能 → Apps Script」，把本檔內容貼上並儲存
 *    （若此腳本不是從試算表開啟的，請填入下方 SPREADSHEET_ID）
 * 3. 右上角「部署 → 新增部署作業」→ 類型選「網頁應用程式」
 *    - 執行身分：我
 *    - 誰可以存取：任何人
 * 4. 按「部署」並完成授權，複製「網頁應用程式網址」
 *    形如 https://script.google.com/macros/s/AKfycb.../exec
 * 5. 把該網址貼到 app.js 最上方的 API_URL
 * 6. 之後修改程式碼：「部署 → 管理部署作業 → 編輯 → 版本：新版本 → 部署」，網址不變
 *
 * ===== 工作表欄位（第 1 列為標題列）=====
 * questionsData：觸發地標與區段 | 參考經緯度 | 故事文本與猜謎題目 | 選項A | 選項B | 選項C | 正確解答與故事結語文本
 *                （可選：新增「觸發半徑」欄即可逐題覆寫，未提供則預設 1.0 公里）
 * TripFacts    ：主題 | 參考經緯度 | 觸發半徑 | 破冰問句文本 | 解答與冷知識文本
 * RegionFacts（行政區冷知識，可選）：縣市 | 鄉鎮市區 | 主題 | 破冰問句文本 | 解答與冷知識文本 | 資料來源 | 查證備註 | 狀態
 *   鄉鎮市區有填 = 該鄉鎮；只填縣市 = 整個縣市；兩者皆空 = 全域保底。「狀態」欄只有空白或「通過」的列會發布
 * 「參考經緯度」格式：25.0326, 121.5262　「觸發半徑」單位：公里，空白則用預設值
 * 欄名若再變動，只需修改下方 readPois_ / readFacts_ 的 pick_ 欄名清單（第一個為主要欄名）
 */

const SPREADSHEET_ID = ''; // 留空 = 使用綁定的試算表
const DEFAULT_RADIUS_KM = { poi: 1.0, fact: 5.0 };

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    if (params.action === 'audio') return json_(audioPayload_(params.id)); // 前端下載單段 mp3
    var idx = audioIndex_();
    var pois = readPois_(), facts = readFacts_();
    pois.forEach(function (p) { p.qAudio = idx[hash_(poiSpeech_(p))] || ''; p.aAudio = idx[hash_(p.answer)] || ''; });
    facts.forEach(function (f) { f.qAudio = idx[hash_(f.question)] || ''; f.aAudio = idx[hash_(f.answer)] || ''; });
    var regionFacts = readRegionFacts_();
    regionFacts.forEach(function (f) { f.qAudio = idx[hash_(f.question)] || ''; f.aAudio = idx[hash_(f.answer)] || ''; });
    return json_({
      status: 'success',
      data: { pois: pois, facts: facts, regionFacts: regionFacts }
    });
  } catch (err) {
    return json_({ status: 'error', message: String(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function readPois_() {
  return readRows_('questionsData').map(function (r) {
    var pos = parseLatLng_(pick_(r, ['參考經緯度']));
    var name = pick_(r, ['觸發地標與區段', '景點名稱', '名稱']);
    if (!pos || !name) return null;
    return {
      name: name,
      lat: pos.lat,
      lng: pos.lng,
      radius: parseRadius_(pick_(r, ['觸發半徑', '觸發半徑(公里)']), DEFAULT_RADIUS_KM.poi),
      question: pick_(r, ['故事文本與猜謎題目', '題目', '問題']),
      options: [pick_(r, ['選項A', 'A']), pick_(r, ['選項B', 'B']), pick_(r, ['選項C', 'C'])]
        .filter(function (o) { return o !== ''; }),
      answer: pick_(r, ['正確解答與故事結語文本', '解答', '答案'])
    };
  }).filter(Boolean);
}

function readFacts_() {
  return readRows_('TripFacts').map(function (r) {
    var pos = parseLatLng_(pick_(r, ['參考經緯度']));
    var name = pick_(r, ['主題', '標題', '名稱']);
    if (!pos || !name) return null;
    return {
      name: name,
      lat: pos.lat,
      lng: pos.lng,
      radius: parseRadius_(pick_(r, ['觸發半徑', '觸發半徑(公里)']), DEFAULT_RADIUS_KM.fact),
      question: pick_(r, ['破冰問句文本', '破冰問句', '問句']),
      answer: pick_(r, ['解答與冷知識文本', '解答', '答案'])
    };
  }).filter(Boolean);
}

function readRegionFacts_() {
  if (!ss_().getSheetByName('RegionFacts')) return [];   // 尚未建立此工作表就略過
  return readRows_('RegionFacts').map(function (r) {
    var county = pick_(r, ['縣市']), town = pick_(r, ['鄉鎮市區']), title = pick_(r, ['主題']);
    var q = pick_(r, ['破冰問句文本']), a = pick_(r, ['解答與冷知識文本']), st = pick_(r, ['狀態']);
    if (!title || !q || !a || (st && st !== '通過')) return null;   // 待審的草稿不發布
    return { name: county + town + title, county: county, town: town, question: q, answer: a };
  }).filter(Boolean);
}

/** 讀取工作表，回傳以標題列為 key 的物件陣列 */
function readRows_(sheetName) {
  var ss = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('找不到工作表：' + sheetName);
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var head = values[0].map(function (h) { return String(h).trim(); });
  return values.slice(1).map(function (row) {
    var o = {};
    head.forEach(function (h, i) { o[h] = row[i]; });
    return o;
  });
}

/** 依序嘗試多個欄名，回傳第一個非空值 */
function pick_(row, keys) {
  for (var i = 0; i < keys.length; i++) {
    var v = row[keys[i]];
    if (v !== undefined && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/** "24.12,120.56"（含全形逗號、空白）→ {lat, lng}；格式錯誤回傳 null */
function parseLatLng_(text) {
  var m = String(text || '').match(/-?\d+(?:\.\d+)?/g);
  if (!m || m.length < 2) return null;
  var lat = parseFloat(m[0]), lng = parseFloat(m[1]);
  return isFinite(lat) && isFinite(lng) ? { lat: lat, lng: lng } : null;
}

/** 半徑空白或無效時使用預設值（公里） */
function parseRadius_(text, fallback) {
  var n = parseFloat(String(text).replace(/[^\d.]/g, ''));
  return isFinite(n) && n > 0 ? n : fallback;
}

/* =====================================================================
 * 神經語音預錄（Azure AI Speech，與 Edge 的 YunJhe Online (Natural) 同一個聲音）
 * 設定步驟：
 * 1. Azure 入口網站建立「Speech」資源，取得金鑰與區域（如 eastasia）
 * 2. Apps Script「專案設定 → 指令碼屬性」新增：AZURE_KEY、AZURE_REGION
 * 3. 編輯器選擇函式 generateAudio 並執行（首次需授權 Drive / 外部連線），約 1～2 分鐘
 * 4. 「部署 → 管理部署作業 → 編輯 → 新版本」（新增了權限，需重新授權）
 * 5. 之後改了題庫文字，只要再執行一次 generateAudio（只會補產生有變動的段落）
 * 產生的 mp3 存在雲端硬碟「SurpriseMachineAudio」資料夾，索引記在工作表「AudioIndex」
 * ===================================================================== */
var TTS = {
  voice: 'zh-TW-YunJheNeural', lang: 'zh-TW', rate: '-5%',
  format: 'audio-24khz-48kbitrate-mono-mp3',
  folder: 'SurpriseMachineAudio', index: 'AudioIndex'
};

function generateAudio() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('AZURE_KEY'), region = props.getProperty('AZURE_REGION');
  if (!key || !region) throw new Error('請先在「指令碼屬性」設定 AZURE_KEY 與 AZURE_REGION');
  var sheet = ss_().getSheetByName(TTS.index) || ss_().insertSheet(TTS.index);
  var folder = audioFolder_(), idx = audioIndex_(), texts = [], made = 0;
  readPois_().forEach(function (p) { texts.push(poiSpeech_(p), p.answer); });
  readFacts_().forEach(function (f) { texts.push(f.question, f.answer); });
  readRegionFacts_().forEach(function (f) { texts.push(f.question, f.answer); });
  texts.forEach(function (t) {
    if (!t) return;
    var h = hash_(t);
    if (idx[h]) return;                       // 文字沒變就不重複產生
    var file = folder.createFile(synth_(t, key, region).setName(h + '.mp3'));
    sheet.appendRow([h, file.getId()]);
    idx[h] = file.getId();
    made++;
  });
  Logger.log('新產生 ' + made + ' 段，共 ' + texts.length + ' 段');
}

function synth_(text, key, region) {
  var ssml = "<speak version='1.0' xml:lang='" + TTS.lang + "'><voice name='" + TTS.voice + "'>" +
    "<prosody rate='" + TTS.rate + "'>" + esc_(text) + '</prosody></voice></speak>';
  var res = UrlFetchApp.fetch('https://' + region + '.tts.speech.microsoft.com/cognitiveservices/v1', {
    method: 'post', contentType: 'application/ssml+xml', payload: ssml, muteHttpExceptions: true,
    headers: { 'Ocp-Apim-Subscription-Key': key, 'X-Microsoft-OutputFormat': TTS.format, 'User-Agent': 'SurpriseMachine' }
  });
  if (res.getResponseCode() !== 200) throw new Error('Azure TTS 失敗 ' + res.getResponseCode() + '：' + res.getContentText().slice(0, 200));
  return res.getBlob().setContentType('audio/mpeg');
}

/** 與前端 app.js 念的文字完全一致：題目 + 選項A/B/C */
function poiSpeech_(p) {
  var L = ['A', 'B', 'C'];
  return p.question + '。' + p.options.map(function (o, i) {
    return '選項' + L[i] + '，' + String(o).replace(/^[A-Cabc][.、\s]+/i, '').trim();
  }).join('。') + '。';
}

function esc_(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function hash_(t) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, TTS.voice + TTS.rate + t, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

function ss_() {
  return SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}

function audioFolder_() {
  var it = DriveApp.getFoldersByName(TTS.folder);
  return it.hasNext() ? it.next() : DriveApp.createFolder(TTS.folder);
}

function audioIndex_() {
  var sh = ss_().getSheetByName(TTS.index), map = {};
  if (!sh || sh.getLastRow() < 1) return map;
  sh.getRange(1, 1, sh.getLastRow(), 2).getValues().forEach(function (r) { if (r[0]) map[r[0]] = String(r[1]); });
  return map;
}

/** 只允許下載索引內的檔案，避免被拿來讀取雲端硬碟其他檔案 */
function audioPayload_(id) {
  var idx = audioIndex_();
  var ok = Object.keys(idx).some(function (k) { return idx[k] === id; });
  if (!ok) throw new Error('unknown audio id');
  return { status: 'success', mime: 'audio/mpeg', b64: Utilities.base64Encode(DriveApp.getFileById(id).getBlob().getBytes()) };
}
