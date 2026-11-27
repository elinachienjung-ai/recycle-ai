// ===== 一拍就知道：類別圖示（自己畫的簡單線條圖，因為 emoji 沒有寶特瓶、紙容器、塑膠盒這些） =====
// 每一類一個 24×24 的 SVG，顏色在 color。要換圖就改這裡。
const ICONS = {
  寶特瓶: { color: "#2a78b8", svg: '<rect x="9.5" y="2" width="5" height="3" rx="1"/><path d="M10 5v2c-2 1-3 2.5-3 4.5V20a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-8.5c0-2-1-3.5-3-4.5V5"/><path d="M7 14h10M7 17.5h10"/>' },
  塑膠類: { color: "#e67e22", svg: '<rect x="3" y="6" width="18" height="3.5" rx="1.2"/><path d="M4.5 9.5 6 20h12l1.5-10.5"/><path d="M9 13.5h6"/>' },
  紙類:   { color: "#8d6e63", svg: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/><path d="M9 11h7M9 14h7M9 17h5"/>' },
  紙容器: { color: "#b8860b", svg: '<path d="M7 2.5h10V6l2 3v12.5H5V9l2-3z"/><path d="M7 6h10M5 9h14"/><path d="M9 13h6v4H9z"/>' },
  鐵鋁罐: { color: "#7f8c8d", svg: '<ellipse cx="12" cy="5" rx="6" ry="2"/><path d="M6 5v14c0 1.1 2.7 2 6 2s6-.9 6-2V5"/><path d="M6 8.5c0 1.1 2.7 2 6 2s6-.9 6-2M6 16c0 1.1 2.7 2 6 2s6-.9 6-2"/>' },
  玻璃容器: { color: "#16a085", svg: '<rect x="8" y="2" width="8" height="3" rx="1"/><path d="M8.5 5C6.5 6 5 7.5 5 9.5V20a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9.5C19 7.5 17.5 6 15.5 5"/><path d="M8.5 11v6"/>' },
  電池:   { color: "#c0392b", svg: '<rect x="7" y="4" width="10" height="17.5" rx="2"/><path d="M10 2h4v2h-4z"/><path d="M12 8.5v4M10 10.5h4M10 17h4"/>' },
  飲料杯: { color: "#8e44ad", svg: '<path d="M4.5 8h15"/><path d="M6 8l1.5 13.5h9L18 8"/><path d="M6.5 8c0-2 2.3-3.2 5.5-3.2S17.5 6 17.5 8"/><path d="M13 4.8 15 2"/><circle cx="9.6" cy="18.3" r=".9"/><circle cx="14.2" cy="18.3" r=".9"/><circle cx="12" cy="14.6" r=".9"/>' },
  背景:   { color: "#95a5a6", svg: '<rect x="3" y="5" width="18" height="14" rx="2" stroke-dasharray="3 2.5"/>' },
  其他:   { color: "#555f66", svg: '<path d="M4 6h16M9 6V3.5h6V6M6 6l1 15.5h10L18 6"/><path d="M10 10v8M14 10v8"/>' },
};

// 回傳某一類的圖示 HTML（放進 innerHTML 用）
function iconOf(key, size = "1.2em") {
  const k = ICONS[key] ? key : (typeof classOf === "function" ? classOf(key).key : key);
  const ic = ICONS[k];
  if (!ic) return "♻️";
  return `<svg class="cls-icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${ic.color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ic.svg}</svg>`;
}
