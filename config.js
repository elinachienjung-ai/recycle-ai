// ===== 網站設定檔：要改設定，改這個檔案就好 =====
const CONFIG = {
  // 信心度門檻：AI 最高的機率低於這個數字，就請使用者換角度再拍（0.7 = 70%）
  THRESHOLD: 0.7,

  // 自動校準信心門檻：依「AI 猜成這類時被說不對的比例」調整每一類的門檻
  AUTO_THRESHOLD: { enabled: true, minReports: 10, min: 0.6, max: 0.95 },

  // AI 沒把握時，自動把那張小照片存成「可疑樣本」，給團隊審核後重新訓練
  SAVE_SUSPECTS: true,

  // 原圖和左右翻轉圖各辨識一次再平均（比較穩，建議開著）
  FLIP_AVERAGE: true,

  // 模型位置：空字串＝用網站 model/ 資料夾裡的檔案
  // 也可以貼 Teachable Machine「上傳模型」後的分享連結，例如 "https://teachablemachine.withgoogle.com/models/xxxxxx/"
  MODEL_URL: "",

  // 🧠 即時自學記憶（KNN）：使用者按「不對」並選正確物品 → 記住定格的 3 張畫面，同一個東西再拍就答對
  //   k：跟最像的幾張比；minSimilarity：相似度要多高才算「很像」（0～1，用我們 1174 張訓練照片測過：
  //   不同類別的照片 95% 都低於 0.80，所以設 0.85 比較不會亂認）；minMatches：至少幾張夠像
  //   minConf：夠像的照片裡同一類要占多少（0.75 = 75%）才採用記憶的答案，否則用原本的模型
  //   useConfirmed：團隊審核確認過的照片也放進記憶（所有裝置共享）
  MEMORY: { enabled: true, frames: 3, k: 3, minSimilarity: 0.85, minMatches: 2, minConf: 0.75, max: 600, useConfirmed: true },

  // 🔁 自動重訓：用「原訓練照片＋審核確認的回報照片」重新訓練 AI 的最後一層（在瀏覽器裡，約幾秒）
  //   minPhotos：確認的照片至少幾張才重訓；feedbackWeight：回報照片一張當幾張用（真實環境拍的比較重要）
  RETRAIN: { enabled: true, minPhotos: 5, feedbackWeight: 3, epochs: 20, learningRate: 0.001 },

  // 預設縣市
  DEFAULT_COUNTY: "臺北市",

  // Google 試算表回報網址（Apps Script 部署後的網址，以 /exec 結尾）
  // 填了之後，所有使用者的回報、辨識紀錄、認錯照片都會存到同一份試算表和雲端硬碟。
  // 空字串 = 只存在這台裝置的瀏覽器（localStorage）。設定方法見 README.md 第 4 節。
  SHEET_URL: "https://script.google.com/macros/s/AKfycbzjARxhwArth538-QCu39GSYyJd04gdJoqvWve3tP-Y4t3im_r_IT5wGZxQkQXxfiwNoQ/exec",

  // 回報或可疑樣本的小照片（160×160）是否送到雲端（給團隊審核、重新訓練）
  UPLOAD_PHOTOS: true,

  // （選填）雲端硬碟「一拍就知道_重訓照片」資料夾的網址，儀表板會顯示連結給團隊
  PHOTO_FOLDER_URL: "",

  // 類別設定：網站會用 labels.txt 的名稱自動對應（名稱一樣、或含有 aliases 裡的字都算）
  // key：county_rules.json 裡的類別名稱；name：畫面顯示；icon：圖示；background: true 代表「沒有物品」；cup: true 會顯示飲料杯拆解卡片；say：語音要講的提醒（不講收運時間）
  CLASSES: [
    { key: "寶特瓶",   name: "寶特瓶",     icon: "🧴", aliases: ["PET", "寶特"], say: "請丟資源回收。記得先倒空，瓶蓋和瓶身分開。" },
    { key: "塑膠類",   name: "塑膠類",     icon: "🥡", aliases: ["塑膠", "塑膠餐盒", "塑膠容器"], say: "請丟資源回收的塑膠類。記得先倒掉殘渣，沖洗乾淨。" },
    { key: "紙類",     name: "紙類",       icon: "📦", aliases: ["廢紙", "紙張", "紙箱", "紙"], say: "請丟資源回收的紙類。要保持乾燥，沾到油的紙不能回收。" },
    { key: "紙容器",   name: "紙容器",     icon: "🧃", aliases: ["鋁箔包", "紙盒", "紙杯", "利樂包"], say: "請丟資源回收的紙容器。記得倒空沖洗，吸管拿出來，不要跟廢紙放一起。" },
    { key: "鐵鋁罐",   name: "鐵鋁罐",     icon: "🥫", aliases: ["金屬", "鐵罐", "鋁罐", "易開罐"], say: "請丟資源回收。記得先倒空，沖一下。" },
    { key: "玻璃容器", name: "玻璃容器",   icon: "🍾", aliases: ["玻璃", "玻璃瓶"], say: "請丟資源回收。記得倒空，小心不要打破，跟其他回收物分開。" },
    { key: "電池",     name: "電池",       icon: "🔋", aliases: ["乾電池", "CDCD", "battery"], say: "不可以丟一般垃圾。請單獨交給資源回收車，或拿到超商、量販店回收。" },
    { key: "飲料杯",   name: "飲料杯",     icon: "🥤", aliases: ["手搖杯", "手搖", "手搖飲", "咖啡杯", "咖啡", "杯子"], cup: true },
    { key: "背景",     name: "沒有物品",   icon: "👋", aliases: ["background", "無物品", "沒有東西"], background: true },
  ],

  // 按「不對」時讓使用者選「這是什麼東西」，網站自動對應到類別（使用者不用知道該丟哪類）
  ITEMS: [
    { name: "寶特瓶",           icon: "🧴", key: "寶特瓶" },
    { name: "塑膠便當盒",       icon: "🍱", key: "塑膠類" },
    { name: "布丁盒／優格杯",   icon: "🍮", key: "塑膠類" },
    { name: "洗髮精等塑膠瓶",   icon: "🧼", key: "塑膠類" },
    { name: "紙箱",             icon: "📦", key: "紙類" },
    { name: "報紙／書本",       icon: "📰", key: "紙類" },
    { name: "鋁箔包",           icon: "🧃", key: "紙容器" },
    { name: "牛奶紙盒",         icon: "🥛", key: "紙容器" },
    { name: "紙便當盒",         icon: "🥡", key: "紙容器" },
    { name: "鐵罐／鋁罐",       icon: "🥫", key: "鐵鋁罐" },
    { name: "玻璃瓶",           icon: "🍾", key: "玻璃容器" },
    { name: "乾電池",           icon: "🔋", key: "電池" },
    { name: "手搖飲杯",         icon: "🧋", key: "飲料杯" },
    { name: "咖啡杯",           icon: "☕", key: "飲料杯" },
    { name: "都不是（一般垃圾／其他）", icon: "🚮", key: "其他" },
  ],
};
