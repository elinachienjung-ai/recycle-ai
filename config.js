// ===== 網站設定檔：要改設定，改這個檔案就好 =====
const CONFIG = {
  // 信心度門檻：AI 最高的機率低於這個數字，就請使用者換角度再拍（0.7 = 70%）
  THRESHOLD: 0.7,

  // 預設縣市
  DEFAULT_COUNTY: "臺北市",

  // Google 試算表回報網址（Apps Script 部署後的網址，以 /exec 結尾）
  // 空字串 = 只存在這台裝置的瀏覽器（localStorage）。設定方法見 README.md 第 4 節。
  SHEET_URL: "",

  // 模型標籤（labels.txt 裡的名字）對應到縣市規則的類別
  // key：county_rules.json 裡的類別名稱；name：畫面上顯示的名字
  CLASSES: {
    "鋁箔包":   { key: "紙容器",   name: "紙容器（鋁箔包）", icon: "🧃" },
    "寶特瓶":   { key: "寶特瓶",   name: "寶特瓶（塑膠類）", icon: "🧴" },
    "玻璃瓶":   { key: "玻璃",     name: "玻璃類",           icon: "🍾" },
    "鐵鋁罐":   { key: "鐵鋁罐",   name: "鐵鋁罐（金屬類）", icon: "🥫" },
    "塑膠餐盒": { key: "塑膠餐盒", name: "塑膠餐盒",         icon: "🍱" },
    // labels.txt 第 6 類叫「CDCD」，這裡當作電池類。如果不是電池，請改這一行。
    "CDCD":     { key: "電池",     name: "電池類",           icon: "🔋" },
  },
};
