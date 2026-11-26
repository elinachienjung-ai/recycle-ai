# 一拍就知道：AI 即時辨識回收物分類網站

純 HTML / JavaScript 靜態網站。AI 模型（Teachable Machine 匯出的 TFLite 量化模型）直接在瀏覽器裡執行，影像不會上傳。電腦、手機、平板開同一個網址都能用。

## 1. 資料夾內容

| 檔案 | 用途 |
|---|---|
| `index.html` | 網頁本體 |
| `style.css` | 外觀 |
| `app.js` | 主程式（鏡頭、辨識、語音、回報、儀表板） |
| `config.js` | **設定檔**：信心度門檻、類別名稱與圖示、Google 試算表網址 |
| `model/model.tflite`、`model/labels.txt` | Teachable Machine 訓練出的模型 |
| `data/county_rules.json` | 22 縣市 × 7 個回收類別的規則 |
| `data/drink_cup_rules.json` | 飲料杯拆解步驟（手搖飲、咖啡杯；封膜、吸管、杯蓋、杯身、杯套各丟哪裡，附官方來源） |
| `lib/` | TensorFlow.js 與 TFLite 函式庫（已放在網站裡，比賽現場不用連 CDN） |

## 2. 在自己電腦先試（不用上網部署）

鏡頭只能在 `https://` 或 `http://localhost` 下開啟，直接雙擊 `index.html` **不能用**。

- **方法 A（VS Code）**：安裝擴充功能「Live Server」→ 在 `index.html` 按右鍵 →「Open with Live Server」。
- **方法 B（Python）**：在這個資料夾開終端機，輸入 `python -m http.server 8000`，瀏覽器開 `http://localhost:8000`。

## 3. 免費部署到 GitHub Pages（取得網址）

1. 到 https://github.com 註冊／登入。
2. 右上角「＋」→「New repository」。名稱例如 `recycle-ai`，選 **Public**，按「Create repository」。
3. 在新的 repository 頁面點「uploading an existing file」。
4. 把**這個資料夾裡面的所有東西**（index.html、app.js、config.js、style.css、README.md 和 `model`、`data`、`lib` 三個資料夾）一起拖進網頁。
   - 要拖的是資料夾「裡面」的檔案，不是外層資料夾本身，`index.html` 必須在最上層。
   - 用 Chrome 或 Edge 拖資料夾，子資料夾會自動保留。
5. 下方按「Commit changes」，等上傳完成。
6. 上方「Settings」→ 左邊「Pages」→ Source 選「Deploy from a branch」，Branch 選 `main`、資料夾 `/ (root)` → 「Save」。
7. 等 1～3 分鐘，重新整理 Pages 頁面，上方會出現網址：
   `https://你的帳號.github.io/recycle-ai/`
8. 用電腦和手機打開這個網址，允許使用相機，就可以 demo 了。

之後要更新（例如換新模型）：在 repository 裡進入 `model` 資料夾 →「Add file」→「Upload files」，上傳新的 `model.tflite` 和 `labels.txt` 覆蓋即可，約 1 分鐘後網站就更新。

## 4.（選做）把「不對」回報存到 Google 試算表

沒設定時，回報只存在那台裝置的瀏覽器裡（儀表板看得到、可下載 CSV）。設定後，所有裝置的回報都會集中到同一份試算表，儀表板也會讀試算表。

1. 開一份新的 Google 試算表，命名例如「一拍就知道回報」。
2. 選單「擴充功能」→「Apps Script」，把裡面的程式全部刪掉，貼上：

```javascript
function doPost(e) {
  const d = JSON.parse(e.postData.contents);
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  if (sh.getLastRow() === 0) sh.appendRow(["time", "county", "predicted", "correct", "isCorrect", "confidence"]);
  sh.appendRow([d.time, d.county, d.predicted, d.correct, d.isCorrect, d.confidence]);
  return ContentService.createTextOutput("ok");
}

function doGet() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const rows = sh.getDataRange().getValues();
  const head = rows.shift() || [];
  const list = rows.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
  return ContentService.createTextOutput(JSON.stringify(list)).setMimeType(ContentService.MimeType.JSON);
}
```

3. 按「部署」→「新增部署作業」→ 齒輪選「網頁應用程式」。
   - 執行身分：**我**
   - 誰可以存取：**所有人**
4. 按「部署」，第一次會要求授權（選自己的帳號 →「進階」→「前往…（不安全）」→ 允許）。
5. 複製「網頁應用程式網址」（以 `/exec` 結尾），貼到 `config.js` 的 `SHEET_URL: ""` 引號中間，重新上傳 `config.js`。

## 5. 用回報資料重新訓練模型

1. 儀表板最下方按「📦 下載重訓照片 ZIP」，解壓後每個類別一個資料夾（也可以點單張照片下載）。
2. 回到 Teachable Machine 專案，把照片上傳到**正確的類別**，再按「Train Model」。
3. 匯出：「Export Model」→「TensorFlow Lite」→「Quantized」→ 下載，把新的 `model.tflite`、`labels.txt` 換掉網站 `model/` 裡的檔案。
   - 如果類別名稱改了，記得同步修改 `config.js` 的 `CLASSES`。

## 6. 常改的設定（config.js）

- `THRESHOLD: 0.7`：信心度低於 70% 會請使用者換角度再拍。太常出現「看不清楚」就調低（例如 0.6），太常認錯就調高。
- `CLASSES`：8 個類別（寶特瓶、塑膠類、紙類、紙容器、鐵鋁罐、玻璃容器、電池、背景）的顯示名稱、圖示和別名。網站會用 labels.txt 的名稱自動對應，例如「乾電池」會對到「電池」、「鋁箔包」會對到「紙容器」。辨識到「背景」時會顯示「請把物品放到鏡頭前」；辨識到「飲料杯」（labels 寫手搖杯、咖啡杯也可以）時會顯示飲料杯拆解步驟卡片。

## 7. 使用小技巧（demo 時）

- 按「📸 拍一下」或鍵盤**空白鍵**辨識；結果會大字顯示並語音播報。
- 物品放在畫面**中間**（AI 只看畫面中間的正方形），背景越單純越準。
- 手機有「🔄 換鏡頭」按鈕可切換前後鏡頭。
- 語音沒聲音：確認右上角「🔊 語音」有勾、裝置不是靜音（iPhone 要關掉側邊靜音鍵）。

## 8. 後台儀表板

- 上方可篩選「期間」和「縣市」。
- 數字卡：辨識次數、使用者回報數、回報正確率、沒把握／沒放東西的比例。
- 圖表：各類別正確率、最常被認錯的物品、AI 認錯對照表（混淆矩陣）、最常搞混的組合、每天辨識次數。
- 「🧪 顯示示範資料」：給簡報或影片展示儀表板用，是電腦隨機產生的假資料，畫面上方會一直顯示紅色提醒。**不能當成真實測試結果寫進作品說明書。**
- 辨識次數只記在每台裝置的瀏覽器裡；有設定 Google 試算表時，回報會集中到試算表。
