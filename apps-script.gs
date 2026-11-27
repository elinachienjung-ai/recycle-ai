// ===== 一拍就知道：Google 試算表接收程式（貼到 Apps Script） =====
// 會自動建立三個工作表：「回報」「辨識紀錄」「樣本」
// 「樣本」是使用者回報或 AI 沒把握時存下的小照片，團隊在網站儀表板審核確認後，
// 照片才會存到雲端硬碟「一拍就知道_重訓照片／類別名稱」資料夾，拿去 Teachable Machine 重新訓練。

const REVIEW_CODE = "請改成你們自己的審核碼";   // ← 一定要改！儀表板審核時要輸入這組碼
const PHOTO_FOLDER = "一拍就知道_重訓照片";
const REPORT_HEAD = ["time", "county", "predicted", "item", "correct", "isCorrect", "confidence"];
const SCAN_HEAD = ["time", "county", "predicted", "confidence", "outcome", "threshold"];
const SAMPLE_HEAD = ["id", "time", "county", "source", "predicted", "reported", "item", "confidence", "photo", "status", "label"];

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
      sheet_("辨識紀錄", SCAN_HEAD).appendRow([d.time, d.county, d.predicted, d.confidence, d.outcome, d.threshold || ""]);
    } else if (d.type === "report") {
      sheet_("回報", REPORT_HEAD).appendRow([d.time, d.county, d.predicted, d.item || "", d.correct, d.isCorrect, d.confidence]);
    } else if (d.type === "sample") {
      const photo = String(d.photo || "").length < 45000 ? d.photo || "" : "";  // 一格最多 5 萬字
      sheet_("樣本", SAMPLE_HEAD).appendRow([d.id, d.time, d.county, d.source, d.predicted, d.reported || "", d.item || "", d.confidence, photo, "待審核", ""]);
    } else if (d.type === "review") {
      if (d.code !== REVIEW_CODE) return ContentService.createTextOutput("wrong code");
      const sh = sheet_("樣本", SAMPLE_HEAD), v = sh.getDataRange().getValues();
      for (let i = 1; i < v.length; i++) {
        if (String(v[i][0]) !== String(d.id)) continue;
        sh.getRange(i + 1, 10, 1, 2).setValues([[d.status, d.label || ""]]);
        if (d.status === "已確認" && d.label && d.label !== "其他" && v[i][8]) {
          const sub = folder_(String(d.label), folder_(PHOTO_FOLDER));
          const bytes = Utilities.base64Decode(String(v[i][8]).split(",")[1]);
          sub.createFile(Utilities.newBlob(bytes, "image/jpeg", d.label + "_" + d.id + ".jpg"));
        }
        if (d.status === "已刪除") sh.getRange(i + 1, 9).setValue("");  // 刪除照片
        break;
      }
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

// 儀表板讀資料：只有「待審核」的樣本會附照片（最多 60 張）
// 網址加 ?type=train：給網站「AI 自學」用，回傳審核確認過的照片（最新 400 張）
function doGet(e) {
  if (e && e.parameter && e.parameter.type === "train") {
    const train = rows_("樣本").filter((s) => s.status === "已確認" && s.photo && s.label && s.label !== "其他")
      .slice(-400).map((s) => ({ id: s.id, label: s.label, photo: s.photo }));
    return ContentService.createTextOutput(JSON.stringify({ train: train })).setMimeType(ContentService.MimeType.JSON);
  }
  let withPhoto = 0;
  const samples = rows_("樣本").reverse().map((s) => {
    if (s.status !== "待審核" || ++withPhoto > 60) s.photo = "";
    return s;
  });
  const out = { reports: rows_("回報"), scans: rows_("辨識紀錄"), samples: samples };
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
