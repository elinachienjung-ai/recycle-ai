// ===== 一拍就知道：主程式 =====
// 流程：載入模型 → 開鏡頭 → 每 0.25 秒辨識一次（畫面左下即時顯示）→ 按「拍一下」取最近幾次平均 → 顯示結果＋語音

const $ = (id) => document.getElementById(id);
let model = null;          // TFLite 模型
let labels = [];           // labels.txt 的類別名稱
let rules = null;          // 縣市規則
let stream = null;         // 鏡頭串流
let facing = "environment";// 手機預設用後鏡頭
let recent = [];           // 最近幾次的辨識機率（用來平均，讓結果比較穩）
let lastResult = null;     // 最近一次「拍一下」的結果（回報用）
let inputInfo = null;      // 模型輸入格式

// ---------- 1. 載入模型、標籤、縣市規則 ----------
async function init() {
  // 縣市選單
  rules = await (await fetch("data/county_rules.json")).json();
  const sel = $("county");
  for (const c of Object.keys(rules.rules)) sel.add(new Option(c, c));
  sel.value = localStorage.getItem("county") || CONFIG.DEFAULT_COUNTY;
  sel.onchange = () => { localStorage.setItem("county", sel.value); if (lastResult) showResult(lastResult); };

  // 標籤：每行像「0 寶特瓶」，去掉前面的數字
  const txt = await (await fetch("model/labels.txt")).text();
  labels = txt.trim().split(/\r?\n/).map((l) => l.replace(/^\d+\s+/, "").trim());

  // 模型
  tflite.setWasmPath("lib/tflite/");
  model = await tflite.loadTFLiteModel("model/model.tflite");
  inputInfo = model.inputs[0];   // 例如 shape [1,224,224,3]、dtype int32（量化）或 float32
  console.log("模型輸入", inputInfo.shape, inputInfo.dtype, "類別", labels);
  $("status").textContent = "模型準備好了！按「開啟鏡頭」開始";
  window.__ready = true;
}

// ---------- 2. 鏡頭 ----------
async function startCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false,
    });
  } catch (e) {
    $("status").textContent = "打不開鏡頭：請允許瀏覽器使用相機（網址要是 https）。" + e.name;
    return;
  }
  const v = $("video");
  v.srcObject = stream;
  await v.play();
  // 前鏡頭（電腦鏡頭）畫面左右翻轉，看起來像照鏡子
  const s = stream.getVideoTracks()[0].getSettings();
  v.classList.toggle("mirror", s.facingMode !== "environment");
  $("status").textContent = "";
  $("btn-start").hidden = true;
  $("btn-snap").disabled = false;
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  $("btn-flip").hidden = cams.length < 2;
  loop();
}

// ---------- 3. 辨識一張畫面 ----------
// 跟 Teachable Machine 一樣：取畫面中間的正方形，縮成 224×224
function predictFrame(source) {
  const [, h, w] = inputInfo.shape;
  const c = $("crop"); c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const sw = source.videoWidth || source.width, sh = source.videoHeight || source.height;
  const side = Math.min(sw, sh);
  ctx.drawImage(source, (sw - side) / 2, (sh - side) / 2, side, side, 0, 0, w, h);

  return tf.tidy(() => {
    let img = tf.expandDims(tf.browser.fromPixels(c), 0);        // 0~255
    if (inputInfo.dtype === "float32") img = tf.sub(tf.div(tf.cast(img, "float32"), 127.5), 1); // 浮點模型要 -1~1
    else img = tf.cast(img, "int32");                            // 量化模型直接用 0~255
    let out = model.predict(img);
    if (!(out instanceof tf.Tensor)) out = Object.values(out)[0];
    let p = Array.from(out.dataSync());
    if (out.dtype === "int32") p = p.map((x) => x / 255);        // 量化輸出 0~255 → 0~1
    const sum = p.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 0.05) {                               // 不是機率就做 softmax
      const m = Math.max(...p), e = p.map((x) => Math.exp(x - m)), s = e.reduce((a, b) => a + b, 0);
      p = e.map((x) => x / s);
    }
    return p;
  });
}

function topOf(p) {
  let i = 0;
  p.forEach((v, k) => { if (v > p[i]) i = k; });
  return { index: i, label: labels[i], conf: p[i] };
}

// 即時辨識迴圈（約每 0.25 秒一次）
let lastTick = 0;
function loop(t = 0) {
  if (!stream) return;
  if (t - lastTick > 250 && $("video").readyState >= 2) {
    lastTick = t;
    const p = predictFrame($("video"));
    recent.push(p); if (recent.length > 6) recent.shift();
    const top = topOf(p);
    const info = CONFIG.CLASSES[top.label] || { name: top.label, icon: "" };
    $("live-label").textContent = `${info.icon} ${info.name}`;
    $("live-conf").textContent = Math.round(top.conf * 100) + "%";
  }
  requestAnimationFrame(loop);
}

// ---------- 4. 拍一下 ----------
function snap() {
  if (!recent.length) return;
  // 平均最近 6 次結果，比只看一張穩定
  const avg = recent[0].map((_, k) => recent.reduce((s, p) => s + p[k], 0) / recent.length);
  const top = topOf(avg);
  lastResult = { ...top, probs: avg, thumb: thumbnail() };
  $("fb-ask").hidden = false; $("fb-choose").hidden = true; $("fb-thanks").hidden = true;

  if (top.conf < CONFIG.THRESHOLD) {
    $("result").hidden = true; $("lowconf").hidden = false;
    $("lc-conf").textContent = Math.round(top.conf * 100) + "%";
    speak("看不太清楚，請換個角度再拍一次");
    return;
  }
  showResult(lastResult);
}

function ruleFor(label) {
  const info = CONFIG.CLASSES[label] || { key: label, name: label, icon: "♻️" };
  const r = (rules.rules[$("county").value] || {})[info.key] || {};
  return { info, r };
}

function showResult(res) {
  const { info, r } = ruleFor(res.label);
  $("lowconf").hidden = true; $("result").hidden = false;
  $("r-icon").textContent = info.icon;
  $("r-name").textContent = info.name;
  $("r-conf").textContent = `AI 信心度 ${Math.round(res.conf * 100)}%`;
  $("r-where").textContent = r["丟哪裡"] || "（查無規則）";
  $("r-prep").textContent = r["前處理"] || "－";
  const src = (r["來源"] || []).map((u, i) => `<a href="${u}" target="_blank" rel="noopener">來源${i + 1}</a>`).join("、");
  $("r-source").innerHTML = `${$("county").value}・${r.status || ""} ${src ? "・" + src : ""}`;
  speak(`這是${info.name}。請丟到${r["丟哪裡"] || ""}。${r["前處理"] || ""}`);
}

// 把目前畫面存成小張照片（回報用，給重新訓練）
function thumbnail() {
  const c = document.createElement("canvas"); c.width = c.height = 160;
  const v = $("video"), side = Math.min(v.videoWidth, v.videoHeight);
  c.getContext("2d").drawImage(v, (v.videoWidth - side) / 2, (v.videoHeight - side) / 2, side, side, 0, 0, 160, 160);
  return c.toDataURL("image/jpeg", 0.7);
}

// ---------- 5. 語音 ----------
function speak(text) {
  if (!$("voice").checked || !window.speechSynthesis) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/[：（）]/g, " "));
  u.lang = "zh-TW"; u.rate = 1;
  const zh = speechSynthesis.getVoices().find((v) => v.lang === "zh-TW") ||
             speechSynthesis.getVoices().find((v) => v.lang.startsWith("zh"));
  if (zh) u.voice = zh;
  speechSynthesis.speak(u);
}

// ---------- 6. 回報（對／不對） ----------
function getReports() { try { return JSON.parse(localStorage.getItem("reports") || "[]"); } catch { return []; } }

function saveReport(correctLabel) {
  const pred = lastResult;
  const rec = {
    time: new Date().toISOString(),
    county: $("county").value,
    predicted: pred.label,
    correct: correctLabel,
    isCorrect: pred.label === correctLabel,
    confidence: Math.round(pred.conf * 100) / 100,
  };
  // 存在本機（認錯的才存照片，最多留 60 張以免塞滿）
  const all = getReports();
  all.push({ ...rec, thumb: rec.isCorrect ? null : pred.thumb });
  let photos = 0;
  for (let i = all.length - 1; i >= 0; i--) if (all[i].thumb && ++photos > 60) all[i].thumb = null;
  try { localStorage.setItem("reports", JSON.stringify(all)); }
  catch { all.forEach((r) => (r.thumb = null)); localStorage.setItem("reports", JSON.stringify(all)); }

  // 有設定 Google 試算表就同時送過去
  if (CONFIG.SHEET_URL) {
    fetch(CONFIG.SHEET_URL, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(rec) })
      .catch((e) => console.warn("送到試算表失敗", e));
  }
  $("fb-ask").hidden = true; $("fb-choose").hidden = true; $("fb-thanks").hidden = false;
  $("fb-thanks").textContent = rec.isCorrect ? "謝謝確認！" : "謝謝回報！這筆資料會用來重新訓練 AI。";
}

function showWrongChoices() {
  $("fb-ask").hidden = true; $("fb-choose").hidden = false;
  const box = $("fb-options"); box.innerHTML = "";
  labels.forEach((l) => {
    if (l === lastResult.label) return;
    const info = CONFIG.CLASSES[l] || { name: l, icon: "" };
    const b = document.createElement("button");
    b.textContent = `${info.icon} ${info.name}`;
    b.onclick = () => saveReport(l);
    box.appendChild(b);
  });
  const other = document.createElement("button");
  other.textContent = "🚮 都不是（一般垃圾／其他）";
  other.onclick = () => saveReport("其他");
  box.appendChild(other);
}

// ---------- 7. 常錯物品儀表板 ----------
async function loadDashboardData() {
  if (CONFIG.SHEET_URL) {
    try {
      const data = await (await fetch(CONFIG.SHEET_URL)).json();
      $("dash-source").textContent = "資料來源：Google 試算表（所有裝置的回報）";
      return { list: data, local: getReports() };
    } catch (e) { console.warn("讀取試算表失敗，改用本機資料", e); }
  }
  $("dash-source").textContent = "資料來源：這台裝置的回報（尚未連接 Google 試算表）";
  return { list: getReports(), local: getReports() };
}

const nameOf = (l) => (CONFIG.CLASSES[l] ? CONFIG.CLASSES[l].icon + " " + CONFIG.CLASSES[l].name : l === "其他" ? "🚮 其他" : l);

async function renderDashboard() {
  const { list, local } = await loadDashboardData();
  const wrong = list.filter((r) => !(r.isCorrect === true || r.isCorrect === "TRUE" || r.isCorrect === "true"));
  $("s-total").textContent = list.length;
  $("s-wrong").textContent = wrong.length;
  $("s-acc").textContent = list.length ? Math.round(((list.length - wrong.length) / list.length) * 100) + "%" : "－";

  // 長條圖：每個正確類別被認錯幾次
  const byClass = {};
  wrong.forEach((r) => (byClass[r.correct] = (byClass[r.correct] || 0) + 1));
  const rows = Object.entries(byClass).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...rows.map((r) => r[1]));
  $("chart").innerHTML = rows.length
    ? rows.map(([k, n]) => `<div class="bar-row" title="${nameOf(k)}：被認錯 ${n} 次"><span>${nameOf(k)}</span>
        <div class="bar-track"><div class="bar" style="width:${(n / max) * 100}%"></div></div><span class="bar-val">${n}</span></div>`).join("")
    : `<p class="muted">還沒有「不對」的回報。辨識後按「❌ 不對」就會出現在這裡。</p>`;

  // 搞混組合
  const pairs = {};
  wrong.forEach((r) => { const k = r.predicted + "→" + r.correct; pairs[k] = (pairs[k] || 0) + 1; });
  $("pairs").innerHTML = Object.entries(pairs).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([k, n]) => { const [a, b] = k.split("→"); return `<tr><td>${nameOf(a)}</td><td>${nameOf(b)}</td><td>${n}</td></tr>`; })
    .join("") || `<tr><td colspan="3" class="muted">尚無資料</td></tr>`;

  // 照片牆
  const groups = {};
  local.filter((r) => r.thumb).forEach((r) => (groups[r.correct] = groups[r.correct] || []).push(r));
  $("gallery").innerHTML = Object.entries(groups).map(([k, arr]) => `<div class="gal-group"><h3>${nameOf(k)}（${arr.length} 張）</h3><div class="gal">` +
    arr.map((r, i) => `<a href="${r.thumb}" download="${k}_${r.time.replace(/[:.]/g, "-")}.jpg" title="AI 認成 ${nameOf(r.predicted)}"><img src="${r.thumb}" alt=""></a>`).join("") +
    `</div></div>`).join("") || `<p class="muted">尚無照片</p>`;
}

function downloadCSV() {
  const list = getReports();
  const head = ["時間", "縣市", "AI認成", "正確類別", "是否正確", "信心度"];
  const lines = [head.join(",")].concat(list.map((r) => [r.time, r.county, r.predicted, r.correct, r.isCorrect, r.confidence].join(",")));
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "回報紀錄.csv"; a.click();
}

// ---------- 8. 按鈕 ----------
$("btn-start").onclick = startCamera;
$("btn-snap").onclick = snap;
$("btn-flip").onclick = () => { facing = facing === "environment" ? "user" : "environment"; recent = []; startCamera(); };
$("btn-right").onclick = () => saveReport(lastResult.label);
$("btn-wrong").onclick = showWrongChoices;
$("btn-csv").onclick = downloadCSV;
$("btn-clear").onclick = () => { if (confirm("確定清除這台裝置的所有回報？")) { localStorage.removeItem("reports"); renderDashboard(); } };
document.addEventListener("keydown", (e) => { if (e.code === "Space" && !$("btn-snap").disabled) { e.preventDefault(); snap(); } });
document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
  $("page-scan").hidden = t.dataset.page !== "scan";
  $("page-dash").hidden = t.dataset.page !== "dash";
  if (t.dataset.page === "dash") renderDashboard();
}));
if (window.speechSynthesis) speechSynthesis.onvoiceschanged = () => {};

init().catch((e) => { console.error(e); $("status").textContent = "模型載入失敗：" + e.message; });
