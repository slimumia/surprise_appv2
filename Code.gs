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
 * 「參考經緯度」格式：25.0326, 121.5262　「觸發半徑」單位：公里，空白則用預設值
 * 欄名若再變動，只需修改下方 readPois_ / readFacts_ 的 pick_ 欄名清單（第一個為主要欄名）
 */

const SPREADSHEET_ID = ''; // 留空 = 使用綁定的試算表
const DEFAULT_RADIUS_KM = { poi: 1.0, fact: 5.0 };

function doGet() {
  try {
    return json_({
      status: 'success',
      data: { pois: readPois_(), facts: readFacts_() }
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
