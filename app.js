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

// ---------- 1. 載入模型、標籤、縣市規則 ----------
async function init() {
  // 縣市選單
  rules = await (await fetch("data/county_rules.json")).json();
  cupRules = await (await fetch("data/drink_cup_rules.json")).json();
  const sel = $("county");
  for (const c of Object.keys(rules.rules)) { sel.add(new Option(c, c)); $("f-county").add(new Option(c, c)); }
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
// 跟 Teachable Machine 一樣：取畫面中間的正方形，縮成 224×224。
// Teachable Machine 用鏡頭蒐集照片時會左右翻轉，所以「原圖」和「翻轉圖」各辨識一次再平均，結果比較穩。
function predictFrame(source) {
  const [, h, w] = inputInfo.shape;
  const c = $("crop"); c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const sw = source.videoWidth || source.width, sh = source.videoHeight || source.height;
  const side = Math.min(sw, sh);
  const results = [];
  for (const flip of CONFIG.FLIP_AVERAGE ? [false, true] : [false]) {
    ctx.setTransform(flip ? -1 : 1, 0, 0, 1, flip ? w : 0, 0);
    ctx.drawImage(source, (sw - side) / 2, (sh - side) / 2, side, side, 0, 0, w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    results.push(runModel(c));
  }
  return results[0].map((_, k) => results.reduce((s, p) => s + p[k], 0) / results.length);
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
    const p = predictFrame($("video"));
    recent.push(p); if (recent.length > 6) recent.shift();
    const top = topOf(p);
    const info = classOf(top.label);
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

  // 「背景」類：鏡頭前沒有東西
  if (classOf(top.label).background) {
    $("result").hidden = true; $("lowconf").hidden = true; $("nothing").hidden = false;
    logScan(top, "background");
    speak("請把物品放到鏡頭前");
    return;
  }
  if (top.conf < CONFIG.THRESHOLD) {
    $("result").hidden = true; $("nothing").hidden = true; $("lowconf").hidden = false;
    $("lc-conf").textContent = Math.round(top.conf * 100) + "%";
    logScan(top, "lowconf");
    speak("看不太清楚，請換個角度再拍一次");
    return;
  }
  logScan(top, "ok");
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
  $("r-conf").textContent = `AI 信心度 ${Math.round(res.conf * 100)}%`;
  $("r-where").textContent = r["丟哪裡"] || "（查無規則）";
  $("r-prep").textContent = r["前處理"] || "－";
  const src = (r["來源"] || []).map((u, i) => `<a href="${u}" target="_blank" rel="noopener">來源${i + 1}</a>`).join("、");
  $("r-source").innerHTML = `${$("county").value}・${r.status || ""} ${src ? "・" + src : ""}`;
  if (info.cup) { showCup(); return; }
  $("cup").hidden = true;
  speak(`這是${info.name}。請丟到${r["丟哪裡"] || ""}。${r["前處理"] || ""}`);
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

// ---------- 6. 回報（對／不對）與辨識紀錄 ----------
// 所有紀錄都存「類別 key」（例如 "塑膠類"），不存 labels.txt 原始名稱，換模型也能延續統計
const load = (k) => { try { return JSON.parse(localStorage.getItem(k) || "[]"); } catch { return []; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
function getReports() { return load("reports"); }
function getScans() { return load("scans"); }

// 每按一次「拍一下」記一筆：結果是 ok（有答案）、lowconf（沒把握）、background（沒東西）
function logScan(top, outcome) {
  const all = getScans();
  all.push({ time: new Date().toISOString(), county: $("county").value, predicted: classOf(top.label).key,
             confidence: Math.round(top.conf * 100) / 100, outcome });
  store("scans", all.slice(-3000));
}

function saveReport(correctKey) {
  const pred = lastResult;
  const predKey = classOf(pred.label).key;
  const rec = {
    time: new Date().toISOString(),
    county: $("county").value,
    predicted: predKey,
    correct: correctKey,
    isCorrect: predKey === correctKey,
    confidence: Math.round(pred.conf * 100) / 100,
  };
  // 存在本機（認錯的才存照片，最多留 80 張以免塞滿）
  const all = getReports();
  all.push({ ...rec, thumb: rec.isCorrect ? null : pred.thumb });
  let photos = 0;
  for (let i = all.length - 1; i >= 0; i--) if (all[i].thumb && ++photos > 80) all[i].thumb = null;
  if (!store("reports", all)) { all.forEach((r) => (r.thumb = null)); store("reports", all); }

  // 有設定 Google 試算表就同時送過去
  if (CONFIG.SHEET_URL) {
    fetch(CONFIG.SHEET_URL, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(rec) })
      .catch((e) => console.warn("送到試算表失敗", e));
  }
  $("fb-ask").hidden = true; $("fb-choose").hidden = true; $("fb-thanks").hidden = false;
  $("fb-thanks").textContent = rec.isCorrect ? "謝謝確認！" : "謝謝回報！這筆資料會用來重新訓練 AI。";
}

// 「不對」的選項：列出所有類別（不含背景和 AI 剛剛猜的那類）
function showWrongChoices() {
  $("fb-ask").hidden = true; $("fb-choose").hidden = false;
  const box = $("fb-options"); box.innerHTML = "";
  const predKey = classOf(lastResult.label).key;
  CONFIG.CLASSES.filter((c) => !c.background && c.key !== predKey).forEach((c) => {
    const b = document.createElement("button");
    b.textContent = `${c.icon} ${c.name}`;
    b.onclick = () => saveReport(c.key);
    box.appendChild(b);
  });
  const other = document.createElement("button");
  other.textContent = "🚮 都不是（一般垃圾／其他）";
  other.onclick = () => saveReport("其他");
  box.appendChild(other);
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
  if (demoMode) { const d = makeDemoData(); $("dash-source").textContent = "資料來源：示範資料"; return { list: d.reports, local: [], scans: d.scans }; }
  if (CONFIG.SHEET_URL) {
    try {
      const data = await (await fetch(CONFIG.SHEET_URL)).json();
      $("dash-source").textContent = "資料來源：Google 試算表（所有裝置的回報）＋這台裝置的辨識次數";
      return { list: data, local: getReports(), scans: getScans() };
    } catch (e) { console.warn("讀取試算表失敗，改用本機資料", e); }
  }
  $("dash-source").textContent = "資料來源：這台裝置（尚未連接 Google 試算表）";
  return { list: getReports(), local: getReports(), scans: getScans() };
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
  const list = applyFilter(data.list), scans = applyFilter(data.scans), local = applyFilter(data.local);
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

  // 6. 重訓照片（依正確類別分組）
  const groups = {};
  local.filter((r) => r.thumb).forEach((r) => (groups[r.correct] = groups[r.correct] || []).push(r));
  $("gallery").innerHTML = Object.entries(groups).map(([k, arr]) => `<div class="gal-group"><h3>${nameOf(k)}（${arr.length} 張）</h3><div class="gal">` +
    arr.map((r) => `<a href="${r.thumb}" download="${k}_${r.time.replace(/[:.]/g, "-")}.jpg" title="AI 認成 ${nameOf(r.predicted)}"><img src="${r.thumb}" alt=""></a>`).join("") +
    `</div></div>`).join("") || `<p class="muted">${demoMode ? "示範資料沒有照片" : "尚無照片"}</p>`;
  $("btn-zip").disabled = !Object.keys(groups).length;
}

function downloadCSV() {
  const list = demoMode ? makeDemoData().reports : getReports();
  const head = ["時間", "縣市", "AI認成", "正確類別", "是否正確", "信心度"];
  const lines = [head.join(",")].concat(list.map((r) => [r.time, r.county, r.predicted, r.correct, r.isCorrect, r.confidence].join(",")));
  saveFile(new Blob(["﻿" + lines.join("\n")], { type: "text/csv" }), demoMode ? "示範資料_回報紀錄.csv" : "回報紀錄.csv");
}

function saveFile(blob, name) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// 把認錯的照片打包成 ZIP：每個類別一個資料夾，解壓後可直接整包上傳到 Teachable Machine 對應類別
function downloadZip() {
  const files = [];
  getReports().filter((r) => r.thumb).forEach((r, i) => {
    const bin = atob(r.thumb.split(",")[1]), bytes = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
    files.push({ name: `${r.correct}/${r.correct}_${String(i + 1).padStart(3, "0")}.jpg`, data: bytes });
  });
  saveFile(makeZip(files), "重訓照片.zip");
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
$("btn-flip").onclick = () => { facing = facing === "environment" ? "user" : "environment"; recent = []; startCamera(); };
$("btn-right").onclick = () => saveReport(classOf(lastResult.label).key);
$("btn-wrong").onclick = showWrongChoices;
$("btn-csv").onclick = downloadCSV;
$("btn-zip").onclick = downloadZip;
$("btn-demo").onclick = () => { demoMode = !demoMode; renderDashboard(); };
$("f-range").onchange = renderDashboard;
$("f-county").onchange = renderDashboard;
$("btn-clear").onclick = () => { if (confirm("確定清除這台裝置的所有回報和辨識紀錄？")) { localStorage.removeItem("reports"); localStorage.removeItem("scans"); renderDashboard(); } };
document.addEventListener("keydown", (e) => { if (e.code === "Space" && !$("btn-snap").disabled) { e.preventDefault(); snap(); } });
document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
  $("page-scan").hidden = t.dataset.page !== "scan";
  $("page-dash").hidden = t.dataset.page !== "dash";
  if (t.dataset.page === "dash") renderDashboard();
}));
if (window.speechSynthesis) speechSynthesis.onvoiceschanged = () => {};

init().catch((e) => { console.error(e); $("status").textContent = "模型載入失敗：" + e.message; });
