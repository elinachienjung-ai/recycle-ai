// ===== 一拍就知道：Google 試算表接收程式（貼到 Apps Script） =====
// 會自動建立兩個工作表：「回報」「辨識紀錄」
// 認錯的照片會存到雲端硬碟「一拍就知道_重訓照片／類別名稱」資料夾，可直接拿去 Teachable Machine 重新訓練

const PHOTO_FOLDER = "一拍就知道_重訓照片";
const REPORT_HEAD = ["time", "county", "predicted", "correct", "isCorrect", "confidence", "photo"];
const SCAN_HEAD = ["time", "county", "predicted", "confidence", "outcome"];

function sheet_(name, head) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(head); }
  return sh;
}

function folder_(name, parent) {
  const it = parent ? parent.getFoldersByName(name) : DriveApp.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return parent ? parent.createFolder(name) : DriveApp.createFolder(name);
}

// 網站送資料進來
function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);  // 很多人同時送也不會打架
  try {
    const d = JSON.parse(e.postData.contents);
    if (d.type === "scan") {
      sheet_("辨識紀錄", SCAN_HEAD).appendRow([d.time, d.county, d.predicted, d.confidence, d.outcome]);
    } else {
      let link = "";
      if (d.photo) {
        const sub = folder_(String(d.correct), folder_(PHOTO_FOLDER));
        const bytes = Utilities.base64Decode(String(d.photo).split(",")[1]);
        const name = d.correct + "_" + String(d.time).replace(/[:.]/g, "-") + ".jpg";
        link = sub.createFile(Utilities.newBlob(bytes, "image/jpeg", name)).getUrl();
      }
      sheet_("回報", REPORT_HEAD).appendRow([d.time, d.county, d.predicted, d.correct, d.isCorrect, d.confidence, link]);
    }
    return ContentService.createTextOutput("ok");
  } finally {
    lock.releaseLock();
  }
}

function rows_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) return [];
  const v = sh.getDataRange().getValues();
  const head = v.shift() || [];
  return v.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] instanceof Date ? r[i].toISOString() : r[i]])));
}

// 儀表板讀資料（不含照片）
function doGet() {
  const out = { reports: rows_("回報").map((r) => { delete r.photo; return r; }), scans: rows_("辨識紀錄") };
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
