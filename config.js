// ===== 網站設定檔：要改設定，改這個檔案就好 =====
const CONFIG = {
  // 信心度門檻：AI 最高的機率低於這個數字，就請使用者換角度再拍（0.7 = 70%）
  THRESHOLD: 0.7,

  // 原圖和左右翻轉圖各辨識一次再平均（比較穩，建議開著）
  FLIP_AVERAGE: true,

  // 預設縣市
  DEFAULT_COUNTY: "臺北市",

  // Google 試算表回報網址（Apps Script 部署後的網址，以 /exec 結尾）
  // 空字串 = 只存在這台裝置的瀏覽器（localStorage）。設定方法見 README.md 第 4 節。
  SHEET_URL: "",

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
};
