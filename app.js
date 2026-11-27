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
let cupRules = null;       // 手搖飲拆解規則
let modelFormat = "";      // 模型格式
let recentSrc = [];        // 最近幾次的答案來源：model 原模型／retrained 重訓模型／memory 自學記憶

// ---------- 1. 載入模型、標籤、縣市規則 ----------
async function init() {
  // 縣市選單
  rules = await (await fetch("data/county_rules.json")).json();
  cupRules = await (await fetch("data/drink_cup_rules.json")).json();
  const sel = $("county");
  for (const c of Object.keys(rules.rules)) { sel.add(new Option(c, c)); $("f-county").add(new Option(c, c)); }
  sel.value = localStorage.getItem("county") || CONFIG.DEFAULT_COUNTY;
  sel.onchange = () => { localStorage.setItem("county", sel.value); if (lastResult) showResult(lastResult); };

  // 模型：支援兩種 Teachable Machine 匯出格式
  //  (1) TensorFlow.js：model.json + weights.bin + metadata.json（或 Teachable Machine 的分享連結）
  //  (2) TensorFlow Lite：model.tflite + labels.txt
  const base = CONFIG.MODEL_URL || "model/";
  // 加上每 10 分鐘換一次的版本號，避免換新模型後還讀到 GitHub 快取的舊檔
  const v = "?v=" + Math.floor(Date.now() / 600000);
  let meta = null;
  try { const r = await fetch(base + "metadata.json" + v, { cache: "no-cache" }); if (r.ok) meta = await r.json(); } catch {}
  if (meta) {
    try { await tf.setBackend("webgl"); } catch { await tf.setBackend("cpu"); }
    await tf.ready();
    labels = meta.labels;
    model = await tf.loadLayersModel(base + "model.json" + v);
    const shp = model.inputs[0].shape;                 // [null, 224, 224, 3]
    inputInfo = { shape: [1, shp[1], shp[2], shp[3]], dtype: "float32" };
    modelFormat = "TensorFlow.js";
  } else {
    // 標籤：每行像「0 寶特瓶」，去掉前面的數字
    const txt = await (await fetch(base + "labels.txt" + v, { cache: "no-cache" })).text();
    labels = txt.trim().split(/\r?\n/).map((l) => l.replace(/^\d+\s+/, "").trim());
    tflite.setWasmPath("lib/tflite/");
    // 用 no-cache 確保換新模型後瀏覽器不會用到舊的
    const buf = await (await fetch(base + "model.tflite" + v, { cache: "no-cache" })).arrayBuffer();
    model = await tflite.loadTFLiteModel(buf);
    inputInfo = model.inputs[0];   // 例如 shape [1,224,224,3]、dtype int32（量化）或 float32
    modelFormat = "TensorFlow Lite";
  }
  console.log("模型", modelFormat, inputInfo.shape, inputInfo.dtype, "類別", labels);
  // 檢查類別名稱是否都對得上網站設定
  const unknown = labels.filter((l) => !CONFIG.CLASSES.some((c) => c === classOf(l)));
  if (unknown.length) console.warn("這些類別名稱網站不認得，請到 config.js 的 CLASSES 加別名：", unknown);
  $("status").textContent = "模型準備好了！按「開啟鏡頭」開始";
  window.__ready = true;
  computeThresholds();
  rtStart();   // 自學記憶＋整體重訓（retrain.js），在背景載入，不會擋住辨識
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
// 跟 Teachable Machine 一樣：取畫面中間的正方形，縮成 224×224。
// Teachable Machine 用鏡頭蒐集照片時會左右翻轉，所以「原圖」和「翻轉圖」各辨識一次再平均，結果比較穩。
function predictFrame(source) {
  const [, h, w] = inputInfo.shape;
  const c = $("crop"); c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const sw = source.videoWidth || source.width, sh = source.videoHeight || source.height;
  const side = Math.min(sw, sh);
  const results = [];
  let memory = null;
  const embed = rtNeedEmbed();   // 有自學記憶或重訓模型時，才需要 MobileNet 特徵（retrain.js）
  for (const flip of CONFIG.FLIP_AVERAGE ? [false, true] : [false]) {
    ctx.setTransform(flip ? -1 : 1, 0, 0, 1, flip ? w : 0, 0);
    ctx.drawImage(source, (sw - side) / 2, (sh - side) / 2, side, side, 0, 0, w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (embed) {
      const t = rtEmbed(c), vec = t.dataSync(); t.dispose();
      if (!flip) memory = rtRecall(vec);                       // 先問「自學記憶」
      results.push(rtActive() ? rtPredict(vec) : runModel(c));  // 有重訓模型就用重訓模型
    } else results.push(runModel(c));
  }
  // 自學記憶有把握（≥ 75%）→ 直接用記憶的答案；否則用模型
  if (memory && memory.conf >= CONFIG.MEMORY.minConf) return { probs: memory.probs, source: "memory" };
  return { probs: results[0].map((_, k) => results.reduce((s, p) => s + p[k], 0) / results.length), source: rtActive() ? "retrained" : "model" };
}

function runModel(canvas) {
  return tf.tidy(() => {
    let img = tf.expandDims(tf.browser.fromPixels(canvas), 0);   // 0~255
    if (inputInfo.dtype === "float32") img = tf.sub(tf.div(tf.cast(img, "float32"), 127.5), 1); // 浮點模型要 -1~1
    else img = tf.cast(img, "int32");                            // 量化模型直接用 0~255
    let out = model.predict(img);
    if (!(out instanceof tf.Tensor)) out = Object.values(out)[0];
    let p = Array.from(out.dataSync());
    if (out.dtype === "int32") p = p.map((x) => x / 256);        // 量化輸出 0~255 → 0~1
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
    const { probs: p, source } = predictFrame($("video"));
    recent.push(p); recentSrc.push(source);
    if (recent.length > 6) { recent.shift(); recentSrc.shift(); }
    const top = topOf(p);
    const info = classOf(top.label);
    $("live-label").textContent = `${source === "memory" ? "🧠" : ""}${info.icon} ${info.name}`;
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
  // 答案來源：最近幾次多數來自哪裡
  const cnt = {}; recentSrc.forEach((x) => (cnt[x] = (cnt[x] || 0) + 1));
  const source = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0] || "model";
  lastResult = { ...top, probs: avg, thumb: thumbnail(), source, frames: null };
  // 定格：連拍 3 張留著，使用者按「不對」時拿來教 AI（自學記憶）
  const me = lastResult;
  rtGrabFrames().then((f) => (me.frames = f)).catch(() => {});
  $("fb-ask").hidden = false; $("fb-choose").hidden = true; $("fb-thanks").hidden = true;

  // 「背景」類：鏡頭前沒有東西
  if (classOf(top.label).background) {
    $("result").hidden = true; $("lowconf").hidden = true; $("nothing").hidden = false;
    logScan(top, "background");
    speak("請把物品放到鏡頭前");
    return;
  }
  // 每一類的門檻不一樣：常被認錯的類別，要更有把握才回答（自動校準）
  const thr = thresholdFor(classOf(top.label).key);
  if (top.conf < thr) {
    lastResult.lowconf = true;
    $("btn-teach").hidden = !CONFIG.MEMORY.enabled; $("lc-options").hidden = true; $("lc-thanks").hidden = true;
    $("result").hidden = true; $("nothing").hidden = true; $("lowconf").hidden = false;
    $("lc-conf").textContent = Math.round(top.conf * 100) + "%";
    $("lc-need").textContent = Math.round(thr * 100) + "%";
    logScan(top, "lowconf", thr);
    saveSuspect();
    $("lc-note").hidden = !CONFIG.SAVE_SUSPECTS;
    speak("看不太清楚，請換個角度再拍一次");
    return;
  }
  logScan(top, "ok", thr);
  showResult(lastResult);
}

// 用 labels.txt 的名稱找到對應的類別：先找完全相同，再找名稱裡含有的別名（越長越優先）
function classOf(label) {
  const L = String(label).trim().toLowerCase();
  let best = null, bestLen = 0;
  for (const c of CONFIG.CLASSES) {
    for (const a of [c.key, ...c.aliases]) {
      const A = a.toLowerCase();
      if (L === A) return c;
      if (L.includes(A) && A.length > bestLen) { best = c; bestLen = A.length; }
    }
  }
  return best || { key: label, name: label, icon: "♻️", aliases: [] };
}

function ruleFor(label) {
  const info = classOf(label);
  const r = (rules.rules[$("county").value] || {})[info.key] || {};
  return { info, r };
}

function showResult(res) {
  const { info, r } = ruleFor(res.label);
  $("lowconf").hidden = true; $("nothing").hidden = true; $("result").hidden = false;
  $("r-icon").textContent = info.icon;
  $("r-name").textContent = info.name;
  const pctv = Math.round(res.conf * 100);
  $("r-conf").textContent = `AI 信心度 ${pctv}%`;
  $("r-bar").style.width = pctv + "%";
  $("r-photo").src = res.thumb;
  const from = { memory: "🧠 自學記憶：跟之前被糾正過的照片很像", retrained: "🔁 重訓模型（加入審核過的回報照片）", model: "" }[res.source || "model"];
  $("r-from").textContent = from; $("r-from").hidden = !from;
  $("r-where").textContent = r["丟哪裡"] || "（查無規則）";
  $("r-prep").textContent = r["前處理"] || "－";
  const src = (r["來源"] || []).map((u, i) => `<a href="${u}" target="_blank" rel="noopener">來源${i + 1}</a>`).join("、");
  $("r-source").innerHTML = `${$("county").value}・${r.status || ""} ${src ? "・" + src : ""}`;
  if (info.cup) { showCup(); return; }
  $("cup").hidden = true;
  // 語音只講「是什麼類＋前處理提醒」，不講收運時間
  speak(`這是${info.name}。${info.say || "請丟到" + (r["丟哪裡"] || "")}`);
}

// 手搖飲拆解卡片：杯身、杯蓋、封膜、吸管各丟哪裡
function binClass(where) {
  if (where.includes("一般垃圾")) return "bin-trash";
  if (where.includes("紙")) return "bin-paper";
  if (where.includes("塑膠")) return "bin-plastic";
  return "bin-other";
}
function showCup() {
  const county = $("county").value;
  $("r-where").textContent = "要拆開，各部分丟不同地方（看下面步驟）";
  $("r-prep").textContent = "先把飲料倒掉，杯蓋、杯身、杯套（和封膜、吸管）分開";
  $("r-source").textContent = "";
  const steps = cupRules.steps.map((st) => {
    const local = county === "臺北市" && st["臺北市"] ? `<div class="cup-local">臺北市：${st["臺北市"]}</div>` : "";
    const src = st["來源"].map((u, i) => `<a href="${u}" target="_blank" rel="noopener">來源${i + 1}</a>`).join("、");
    return `<li class="cup-step">
      <span class="cup-num">${st["順序"]}</span><span class="cup-icon">${st.icon}</span>
      <div class="cup-body"><b>${st["組件"]}</b>
        <span class="bin ${binClass(st["丟哪裡"])}">${st["丟哪裡"].replace("資源回收：", "♻️ ").replace("一般垃圾", "🚮 一般垃圾")}</span>
        <div class="cup-prep">${st["前處理"]}</div>${local}
        <div class="cup-src">${st.status}・${src}</div></div></li>`;
  }).join("");
  $("cup").innerHTML = `<h3>🥤 飲料杯拆解步驟</h3><p class="cup-note" style="margin:0 0 8px">手搖飲杯、咖啡杯都適用，杯子沒有的部分就跳過。</p><ol class="cup-list">${steps}</ol>
    <p class="cup-note">${county === "臺北市" ? "" : "其他縣市大原則相同，回收日期與細項請依當地清潔隊規定。"}封膜目前只查到新北市的官方說明，其他縣市先保守丟一般垃圾。</p>`;
  $("cup").hidden = false;
  speak("這是飲料杯，請拆開分類。先把飲料倒掉。封膜和吸管丟一般垃圾。塑膠杯蓋和塑膠杯身回收到塑膠類。紙杯和咖啡紙杯回收到紙容器。紙杯套回收到紙類。");
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

// ---------- 6. 回報、可疑樣本、自動門檻 ----------
// 所有紀錄都存「類別 key」（例如 "塑膠類"），不存 labels.txt 原始名稱，換模型也能延續統計
const load = (k, d = []) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
function getReports() { return load("reports"); }
function getScans() { return load("scans"); }
function getSamples() { return load("samples"); }
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// 每按一次「拍一下」記一筆：結果是 ok（有答案）、lowconf（沒把握）、background（沒東西）
function logScan(top, outcome, threshold) {
  const all = getScans();
  all.push({ time: new Date().toISOString(), county: $("county").value, predicted: classOf(top.label).key,
             confidence: Math.round(top.conf * 100) / 100, outcome, threshold });
  store("scans", all.slice(-3000));
  sendToCloud({ type: "scan", ...all[all.length - 1] });
}

// ---------- 雲端（Google 試算表）：所有使用者的資料存在同一份 ----------
// 送不出去（例如沒網路）就先放在本機「待上傳」，下次開網站或恢復網路時自動補傳
function sendToCloud(data) {
  if (!CONFIG.SHEET_URL) return;
  fetch(CONFIG.SHEET_URL, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(data) })
    .catch(() => { const q = load("pending"); q.push(data); store("pending", q.slice(-500)); });
}
async function flushPending() {
  if (!CONFIG.SHEET_URL || !navigator.onLine) return;
  const q = load("pending"); if (!q.length) return;
  store("pending", []);
  for (const d of q) sendToCloud(d);
}
window.addEventListener("online", flushPending);

// 讀雲端資料（30 秒內重複讀就用上次的結果）
let cloudCache = null, cloudTime = 0;
async function fetchCloud(force) {
  if (!CONFIG.SHEET_URL) return null;
  if (!force && cloudCache && Date.now() - cloudTime < 30000) return cloudCache;
  try {
    const data = await (await fetch(CONFIG.SHEET_URL)).json();
    cloudCache = Array.isArray(data) ? { reports: data, scans: [], samples: [] }   // 舊版接收程式
                                     : { reports: data.reports || [], scans: data.scans || [], samples: data.samples || [] };
    cloudTime = Date.now();
    return cloudCache;
  } catch (e) { console.warn("讀取雲端失敗，改用本機資料", e); return null; }
}

// 存一筆「樣本」（之後要人工審核，確認標籤才會進重訓資料）
// source：「回報」＝使用者按不對；「沒把握」＝AI 信心度不夠，自動存下來
function saveSample(source, extra) {
  const s = { id: newId(), time: new Date().toISOString(), county: $("county").value, source,
              predicted: classOf(lastResult.label).key, confidence: Math.round(lastResult.conf * 100) / 100,
              reported: "", item: "", photo: lastResult.thumb, status: "待審核", label: "", ...extra };
  const all = getSamples(); all.push(s);
  // 本機最多留 120 張照片，舊的先刪照片
  let photos = 0;
  for (let i = all.length - 1; i >= 0; i--) if (all[i].photo && ++photos > 120) all[i].photo = "";
  if (!store("samples", all)) { all.forEach((x, i) => { if (i < all.length - 20) x.photo = ""; }); store("samples", all); }
  if (CONFIG.UPLOAD_PHOTOS) sendToCloud({ type: "sample", ...s });
  else sendToCloud({ type: "sample", ...s, photo: "" });
}

// 「AI 沒把握」時自動存可疑樣本（同一段時間連續重拍只存一張，避免重複）
let lastSuspect = 0;
function saveSuspect() {
  if (!CONFIG.SAVE_SUSPECTS || Date.now() - lastSuspect < 5000) return;
  lastSuspect = Date.now();
  saveSample("沒把握");
}

function saveReport(correctKey, item = "") {
  const pred = lastResult;
  const predKey = classOf(pred.label).key;
  const rec = {
    time: new Date().toISOString(),
    county: $("county").value,
    predicted: predKey,
    correct: correctKey,
    item,
    isCorrect: predKey === correctKey,
    confidence: Math.round(pred.conf * 100) / 100,
  };
  const all = getReports(); all.push(rec); store("reports", all.slice(-5000));
  sendToCloud({ type: "report", ...rec });
  const teach = pred.lowconf;   // 從「看不太清楚」那裡教 AI 的
  if (!rec.isCorrect && !teach) saveSample("回報", { reported: correctKey, item });
  const T = teach ? $("lc-thanks") : $("fb-thanks");
  $("fb-ask").hidden = true; $("fb-choose").hidden = true; $("lc-options").hidden = true; $("btn-teach").hidden = true;
  T.hidden = false;
  T.textContent = rec.isCorrect && !teach ? "謝謝確認！" : "謝謝回報！團隊審核後，這張照片會用來重新訓練 AI。";
  // 自學記憶：馬上學會（「其他」不在 AI 的類別裡，不學）
  if ((!rec.isCorrect || teach) && CONFIG.MEMORY.enabled && correctKey !== "其他") {
    const t0 = performance.now();
    const frames = pred.frames;
    rtRemember(frames, correctKey).then((n) => {
      if (!n) return;
      recent = []; recentSrc = [];
      T.textContent = `🧠 學會了！（${n} 張畫面，${Math.round(performance.now() - t0)} 毫秒）同一個東西再拍一次試試看。團隊審核後，所有人的網站也會學到。`;
    }).catch((e) => console.warn("自學失敗", e));
  }
  computeThresholds();
}

// 「不對」：使用者不一定知道該丟哪類，但知道「這是什麼東西」→ 選物品圖示，網站自動對應類別
function showWrongChoices(boxId = "fb-options") {
  $("fb-ask").hidden = true; $("fb-choose").hidden = false;
  $("privacy-note").hidden = !(CONFIG.SHEET_URL && CONFIG.UPLOAD_PHOTOS);
  const box = $(boxId); box.innerHTML = ""; box.hidden = false;
  CONFIG.ITEMS.forEach((it) => {
    const b = document.createElement("button");
    b.className = "item-btn";
    b.innerHTML = `<span class="item-icon">${it.icon}</span><span>${it.name}</span>`;
    b.onclick = () => saveReport(it.key, it.name);
    box.appendChild(b);
  });
}

// ---------- 自動校準信心門檻（從回報資料中學習） ----------
// 規則：看「AI 猜成這一類」時被使用者說不對的比例（認錯率）
//   回報少於 minReports 筆 → 用預設門檻
//   否則 門檻 = 預設 + 0.5 ×（認錯率 − 10%），並限制在 min～max 之間
//   例：認錯率 10% → 70%；30% → 80%；50% → 90%；0% → 65%
let thresholds = {};
function thresholdFor(key) { return thresholds[key]?.value ?? CONFIG.THRESHOLD; }
async function computeThresholds() {
  const A = CONFIG.AUTO_THRESHOLD;
  const cloud = await fetchCloud();
  const list = cloud ? cloud.reports : getReports();
  const out = {};
  CONFIG.CLASSES.filter((c) => !c.background).forEach((c) => {
    const of = list.filter((r) => r.predicted === c.key);
    const wrong = of.filter((r) => !isTrue(r.isCorrect)).length;
    const rate = of.length ? wrong / of.length : 0;
    let value = CONFIG.THRESHOLD, auto = false;
    if (A.enabled && of.length >= A.minReports) {
      value = Math.min(A.max, Math.max(A.min, CONFIG.THRESHOLD + 0.5 * (rate - 0.1)));
      auto = true;
    }
    out[c.key] = { n: of.length, wrong, rate, value: Math.round(value * 100) / 100, auto };
  });
  thresholds = out;
  return out;
}

// ---------- 7. 後台儀表板 ----------
const isTrue = (v) => v === true || v === "TRUE" || v === "true";
const nameOf = (k) => (k === "其他" ? "🚮 其他" : classOf(k).icon + " " + classOf(k).name);
const pct = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "－");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// 示範資料：給簡報／影片用，畫面會一直顯示紅色提醒，不會和真實資料混在一起
function makeDemoData() {
  const keys = CONFIG.CLASSES.filter((c) => !c.background).map((c) => c.key);
  // 容易搞混的組合（示範用）
  const confuse = { "塑膠類": "寶特瓶", "紙容器": "紙類", "飲料杯": "塑膠類", "玻璃容器": "寶特瓶", "紙類": "紙容器" };
  const counties = ["臺北市", "新北市", "桃園市", "臺中市", "高雄市"];
  const reports = [], scans = [];
  let seed = 7; const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 160; i++) {
    const t = new Date(Date.now() - rnd() * 14 * 864e5).toISOString();
    const correct = keys[Math.floor(rnd() * keys.length)];
    const wrong = rnd() < 0.18 && confuse[correct];
    const predicted = wrong ? confuse[correct] : correct;
    const county = counties[Math.floor(rnd() * counties.length)];
    reports.push({ time: t, county, predicted, correct, isCorrect: predicted === correct, confidence: +(0.7 + rnd() * 0.29).toFixed(2) });
  }
  for (let i = 0; i < 420; i++) {
    const r = rnd(), t = new Date(Date.now() - rnd() * 14 * 864e5).toISOString();
    scans.push({ time: t, county: counties[Math.floor(rnd() * counties.length)], predicted: keys[Math.floor(rnd() * keys.length)],
                 confidence: +(0.5 + rnd() * 0.49).toFixed(2), outcome: r < 0.1 ? "lowconf" : r < 0.15 ? "background" : "ok" });
  }
  return { reports, scans };
}
let demoMode = false;

async function loadDashboardData() {
  if (demoMode) { const d = makeDemoData(); $("dash-source").textContent = "資料來源：示範資料"; return { list: d.reports, scans: d.scans, samples: [] }; }
  const cloud = await fetchCloud(true);
  if (cloud) {
    const pending = load("pending").length;
    $("dash-source").textContent = `資料來源：雲端（所有使用者的資料）${pending ? `・這台裝置還有 ${pending} 筆待上傳` : ""}`;
    return { list: cloud.reports, scans: cloud.scans, samples: cloud.samples, cloud: true };
  }
  $("dash-source").textContent = "資料來源：這台裝置（尚未連接 Google 試算表）";
  return { list: getReports(), scans: getScans(), samples: getSamples() };
}

// 篩選：期間與縣市
function applyFilter(arr) {
  const days = $("f-range").value, county = $("f-county").value;
  const since = days === "all" ? 0 : days === "today" ? new Date().setHours(0, 0, 0, 0) : Date.now() - Number(days) * 864e5;
  return arr.filter((r) => new Date(r.time).getTime() >= since && (county === "all" || r.county === county));
}

function barRows(rows, unit) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return rows.map((r) => `<div class="bar-row" title="${esc(r.tip || "")}"><span>${r.label}</span>
    <div class="bar-track"><div class="bar" style="width:${(r.value / max) * 100}%"></div></div>
    <span class="bar-val">${r.text ?? r.value}${unit || ""}</span></div>`).join("");
}

async function renderDashboard() {
  const data = await loadDashboardData();
  $("demo-banner").hidden = !demoMode;
  $("btn-demo").textContent = demoMode ? "↩️ 回到真實資料" : "🧪 顯示示範資料（簡報用）";
  const list = applyFilter(data.list), scans = applyFilter(data.scans);
  const wrong = list.filter((r) => !isTrue(r.isCorrect));
  const keys = CONFIG.CLASSES.filter((c) => !c.background).map((c) => c.key);

  // 數字卡
  const ok = scans.filter((s) => s.outcome === "ok").length;
  $("s-scans").textContent = scans.length;
  $("s-total").textContent = list.length;
  $("s-acc").textContent = pct(list.length - wrong.length, list.length);
  $("s-low").textContent = pct(scans.length - ok, scans.length);

  // 1. 各類別正確率（使用者按「對」的比例）
  const acc = keys.map((k) => {
    const of = list.filter((r) => r.correct === k), good = of.filter((r) => isTrue(r.isCorrect)).length;
    return { k, n: of.length, good };
  }).filter((r) => r.n > 0).sort((a, b) => a.good / a.n - b.good / b.n);
  $("chart-acc").innerHTML = acc.length
    ? barRows(acc.map((r) => ({ label: nameOf(r.k), value: Math.round((r.good / r.n) * 100), text: Math.round((r.good / r.n) * 100), tip: `${nameOf(r.k)}：${r.n} 筆回報中 ${r.good} 筆正確` })), "%")
    : `<p class="muted">還沒有回報。辨識後按「✅ 對」或「❌ 不對」就會統計。</p>`;

  // 2. 最常被認錯的物品
  const byClass = {};
  wrong.forEach((r) => (byClass[r.correct] = (byClass[r.correct] || 0) + 1));
  const rows = Object.entries(byClass).sort((a, b) => b[1] - a[1]);
  $("chart").innerHTML = rows.length
    ? barRows(rows.map(([k, n]) => ({ label: nameOf(k), value: n, tip: `${nameOf(k)}：被認錯 ${n} 次` })), "")
    : `<p class="muted">還沒有「不對」的回報。</p>`;

  // 3. 混淆矩陣：橫列＝其實是，直欄＝AI 認成
  const cols = keys, rowsK = [...keys, "其他"];
  const m = {}; let mmax = 0;
  list.forEach((r) => { const k = r.correct + "|" + r.predicted; m[k] = (m[k] || 0) + 1; });
  rowsK.forEach((a) => cols.forEach((b) => { if (a !== b) mmax = Math.max(mmax, m[a + "|" + b] || 0); }));
  const head = `<tr><th class="mx-corner">其實是 ↓ ／ AI 認成 →</th>${cols.map((b) => `<th title="${classOf(b).name}">${classOf(b).icon}<span class="mx-name">${classOf(b).name}</span></th>`).join("")}</tr>`;
  const body = rowsK.filter((a) => a !== "其他" || cols.some((b) => m[a + "|" + b])).map((a) => `<tr><th>${nameOf(a)}</th>${cols.map((b) => {
    const n = m[a + "|" + b] || 0, diag = a === b;
    const alpha = diag || !n ? 0 : 0.18 + 0.82 * (n / Math.max(1, mmax));
    return `<td class="${diag ? "mx-diag" : ""}" style="--a:${alpha}" title="其實是 ${classOf(a).name}，AI 認成 ${classOf(b).name}：${n} 次">${n || ""}</td>`;
  }).join("")}</tr>`).join("");
  $("matrix").innerHTML = list.length ? `<table class="mx">${head}${body}</table>` : `<p class="muted">尚無資料</p>`;

  // 4. 搞混組合
  const pairs = {};
  wrong.forEach((r) => { const k = r.predicted + "→" + r.correct; pairs[k] = (pairs[k] || 0) + 1; });
  $("pairs").innerHTML = Object.entries(pairs).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([k, n]) => { const [a, b] = k.split("→"); return `<tr><td>${nameOf(a)}</td><td>${nameOf(b)}</td><td>${n}</td></tr>`; })
    .join("") || `<tr><td colspan="3" class="muted">尚無資料</td></tr>`;

  // 5. 每天的辨識次數（近 14 天）
  const daysArr = [...Array(14)].map((_, i) => { const d = new Date(Date.now() - (13 - i) * 864e5); return d.toISOString().slice(0, 10); });
  const perDay = Object.fromEntries(daysArr.map((d) => [d, 0]));
  scans.forEach((s) => { const d = s.time.slice(0, 10); if (d in perDay) perDay[d]++; });
  const dmax = Math.max(1, ...Object.values(perDay));
  $("chart-days").innerHTML = `<div class="cols">${daysArr.map((d) => `<div class="col" title="${d}：${perDay[d]} 次"><div class="col-bar" style="height:${(perDay[d] / dmax) * 100}%"></div><span>${d.slice(8)}</span></div>`).join("")}</div>`;

  // 6. 自動門檻表
  const thr = demoMode ? demoThresholds(data.list) : await computeThresholds();
  $("thr-table").innerHTML = keys.map((k) => {
    const t = thr[k] || { n: 0, rate: 0, value: CONFIG.THRESHOLD, auto: false };
    return `<tr><td>${nameOf(k)}</td><td>${t.n}</td><td>${t.n ? Math.round(t.rate * 100) + "%" : "－"}</td>
      <td><b>${Math.round(t.value * 100)}%</b></td><td class="muted">${t.auto ? (t.value > CONFIG.THRESHOLD ? "常認錯，提高門檻" : t.value < CONFIG.THRESHOLD ? "很少認錯，稍微放寬" : "維持") : `資料不足（少於 ${CONFIG.AUTO_THRESHOLD.minReports} 筆），用預設`}</td></tr>`;
  }).join("");

  // 7. 審核區：確認標籤後才會進重訓資料
  renderReview(data.samples, data.cloud);
  renderRetrain();
}

// 審核區
function renderReview(samples, cloud) {
  const pending = samples.filter((x) => x.status === "待審核" && x.photo);
  const confirmed = samples.filter((x) => x.status === "已確認");
  $("rv-count").textContent = `待審核 ${pending.length} 張・已確認 ${confirmed.length} 張`;
  $("rv-code-row").hidden = !cloud;
  const opts = (sel) => CONFIG.CLASSES.map((c) => `<option value="${c.key}" ${c.key === sel ? "selected" : ""}>${c.icon} ${c.name}</option>`).join("") +
    `<option value="其他" ${sel === "其他" ? "selected" : ""}>🚮 其他（不用來訓練）</option>`;
  $("review").innerHTML = pending.slice(0, 40).map((x) => `<div class="rv-card" data-id="${esc(x.id)}">
      <img src="${esc(x.photo)}" alt="">
      <div class="rv-info">
        <div><span class="rv-tag ${x.source === "回報" ? "rv-report" : "rv-low"}">${x.source === "回報" ? "使用者回報" : "AI 沒把握"}</span></div>
        <div>AI 認成 ${nameOf(x.predicted)}（${Math.round(x.confidence * 100)}%）</div>
        ${x.source === "回報" ? `<div>使用者說：${esc(x.item || "")} → ${nameOf(x.reported)}</div>` : ""}
        <div class="rv-actions"><select>${opts(x.reported || x.predicted)}</select>
          <button class="ok rv-ok">✅ 確認</button><button class="bad rv-del">🗑</button></div>
      </div></div>`).join("") || `<p class="muted">${demoMode ? "示範資料沒有樣本照片" : "目前沒有待審核的樣本 👍"}</p>`;
  $("review").querySelectorAll(".rv-card").forEach((card) => {
    const id = card.dataset.id;
    card.querySelector(".rv-ok").onclick = () => reviewSample(id, "已確認", card.querySelector("select").value, cloud);
    card.querySelector(".rv-del").onclick = () => reviewSample(id, "已刪除", "", cloud);
  });
  // 已確認的照片（這台裝置）→ 可下載 ZIP
  const groups = {};
  getSamples().filter((x) => x.status === "已確認" && x.photo && x.label !== "其他").forEach((x) => (groups[x.label] = groups[x.label] || []).push(x));
  $("gallery").innerHTML = Object.entries(groups).map(([k, arr]) => `<div class="gal-group"><h3>${nameOf(k)}（${arr.length} 張）</h3><div class="gal">` +
    arr.map((x) => `<a href="${x.photo}" download="${k}_${x.time.replace(/[:.]/g, "-")}.jpg"><img src="${x.photo}" alt=""></a>`).join("") + `</div></div>`).join("") ||
    `<p class="muted">${cloud ? "雲端審核確認的照片會自動放進雲端硬碟資料夾。" : "還沒有已確認的照片。"}</p>`;
  $("btn-zip").disabled = !Object.keys(groups).length;
  $("folder-link").hidden = !CONFIG.PHOTO_FOLDER_URL || demoMode;
  $("folder-link").innerHTML = `📁 審核通過的照片都在 <a href="${esc(CONFIG.PHOTO_FOLDER_URL)}" target="_blank" rel="noopener">雲端硬碟資料夾</a>（每個類別一個資料夾）。`;
}

function reviewSample(id, status, label, cloud) {
  // 本機的樣本直接更新
  const all = getSamples(), s = all.find((x) => x.id === id);
  if (s) { s.status = status; s.label = label; if (status === "已刪除") s.photo = ""; store("samples", all); }
  // 雲端：要輸入審核碼，避免路人亂改
  if (cloud) {
    const code = $("rv-code").value.trim();
    if (!code) { alertBox("請先輸入審核碼"); return; }
    try { localStorage.setItem("reviewCode", code); } catch {}
    sendToCloud({ type: "review", id, status, label, code });
    if (cloudCache) { const c = cloudCache.samples.find((x) => x.id === id); if (c) { c.status = status; c.label = label; } }
  }
  if (status === "已確認") rtSchedule();   // 有新確認的照片 → 自動重新訓練
  renderReview(cloud ? cloudCache.samples : getSamples(), cloud);
}
function alertBox(msg) { $("rv-msg").textContent = msg; setTimeout(() => ($("rv-msg").textContent = ""), 3000); }

// 示範資料的門檻（用示範回報算）
function demoThresholds(list) {
  const A = CONFIG.AUTO_THRESHOLD, out = {};
  CONFIG.CLASSES.filter((c) => !c.background).forEach((c) => {
    const of = list.filter((r) => r.predicted === c.key), wrong = of.filter((r) => !isTrue(r.isCorrect)).length, rate = of.length ? wrong / of.length : 0;
    const auto = of.length >= A.minReports;
    const value = auto ? Math.min(A.max, Math.max(A.min, CONFIG.THRESHOLD + 0.5 * (rate - 0.1))) : CONFIG.THRESHOLD;
    out[c.key] = { n: of.length, wrong, rate, value, auto };
  });
  return out;
}

function downloadCSV() {
  const list = demoMode ? makeDemoData().reports : getReports();
  const head = ["時間", "縣市", "AI認成", "使用者選的物品", "正確類別", "是否正確", "信心度"];
  const lines = [head.join(",")].concat(list.map((r) => [r.time, r.county, r.predicted, r.item || "", r.correct, r.isCorrect, r.confidence].join(",")));
  saveFile(new Blob(["﻿" + lines.join("\n")], { type: "text/csv" }), demoMode ? "示範資料_回報紀錄.csv" : "回報紀錄.csv");
}

function saveFile(blob, name) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// 把認錯的照片打包成 ZIP：每個類別一個資料夾，解壓後可直接整包上傳到 Teachable Machine 對應類別
function downloadZip() {
  const files = [];
  getSamples().filter((x) => x.status === "已確認" && x.photo && x.label !== "其他").forEach((x, i) => {
    const bin = atob(x.photo.split(",")[1]), bytes = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
    files.push({ name: `${x.label}/${x.label}_${String(i + 1).padStart(3, "0")}.jpg`, data: bytes });
  });
  saveFile(makeZip(files), "重訓照片_已審核.zip");
}

// 最簡單的 ZIP 格式（不壓縮），不需要額外函式庫
function makeZip(files) {
  const crcTable = [...Array(256)].map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (d) => { let c = 0xffffffff; for (const b of d) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const now = new Date(), dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const enc = new TextEncoder(), parts = [], central = []; let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true);
    h.setUint32(14, crc, true); h.setUint32(18, size, true); h.setUint32(22, size, true); h.setUint16(26, name.length, true);
    parts.push(h.buffer, name, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true);
    c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true); c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(c.buffer, name);
    offset += 30 + name.length + size;
  }
  const csize = central.reduce((s, b) => s + (b.byteLength ?? b.length), 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, csize, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, e.buffer], { type: "application/zip" });
}

// ---------- 8. 按鈕 ----------
$("btn-start").onclick = startCamera;
$("btn-snap").onclick = snap;
$("btn-flip").onclick = () => { facing = facing === "environment" ? "user" : "environment"; recent = []; recentSrc = []; startCamera(); };
$("btn-right").onclick = () => saveReport(classOf(lastResult.label).key);
$("btn-wrong").onclick = () => showWrongChoices();
$("btn-teach").onclick = () => { $("btn-teach").hidden = true; showWrongChoices("lc-options"); };
$("btn-csv").onclick = downloadCSV;
$("btn-zip").onclick = downloadZip;
$("btn-demo").onclick = () => { demoMode = !demoMode; renderDashboard(); };
$("f-range").onchange = renderDashboard;
$("f-county").onchange = renderDashboard;
try { $("rv-code").value = localStorage.getItem("reviewCode") || ""; } catch {}
$("btn-clear").onclick = () => { if (confirm("確定清除這台裝置的所有回報和辨識紀錄？")) { localStorage.removeItem("reports"); localStorage.removeItem("scans"); localStorage.removeItem("samples"); renderDashboard(); } };
document.addEventListener("keydown", (e) => { if (e.code === "Space" && !$("btn-snap").disabled) { e.preventDefault(); snap(); } });
document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
  $("page-scan").hidden = t.dataset.page !== "scan";
  $("page-dash").hidden = t.dataset.page !== "dash";
  if (t.dataset.page === "dash") renderDashboard();
}));
if (window.speechSynthesis) speechSynthesis.onvoiceschanged = () => {};

flushPending();
init().catch((e) => { console.error(e); $("status").textContent = "模型載入失敗：" + e.message; });
