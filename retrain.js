// ===== 一拍就知道：AI 自動重訓（在瀏覽器裡完成，不需要伺服器） =====
// 原理跟 Teachable Machine 一樣，分成兩段：
//   (1) 「看圖」：MobileNet（lib/mobilenet，Teachable Machine 用的同一個）把照片變成 1280 個數字（特徵）
//   (2) 「判斷」：一個小的神經網路，看這 1280 個數字決定是哪一類 ← 重訓只重新訓練這一段，幾秒就好
// 訓練資料 = 原本的訓練照片（已事先算好特徵，存在 model/train_features.*）＋ 團隊審核確認過的回報照片
// 每次有新的照片被確認，網站會自動重新訓練，訓練好的模型存在這台裝置（IndexedDB），下次打開直接用。

const RT = {
  base: null,        // MobileNet（看圖）
  head: null,        // 重訓出來的小網路（判斷）
  feats: null,       // 原訓練照片的特徵 { X: Float32Array[], y: 類別 key[] }
  featsFrom: "",     // 特徵來源說明
  info: null,        // 上次訓練的結果（給儀表板顯示）
  busy: false,
  msg: "尚未開始",
  timer: null,
};
const RT_SIZE = 160;   // 回報照片是 160×160，所以所有照片都先縮成 160 再放大成 224，大家條件一樣

// ---------- 1. 看圖：照片 → 特徵 ----------
async function rtLoadBase() {
  if (!RT.base) RT.base = await tf.loadLayersModel("lib/mobilenet/model.json");
  return RT.base;
}

const rtSmall = document.createElement("canvas"); rtSmall.width = rtSmall.height = RT_SIZE;
const rtBig = document.createElement("canvas"); rtBig.width = rtBig.height = 224;
// source：canvas 或 img（已經是正方形）
function rtEmbed(source) {
  rtSmall.getContext("2d").drawImage(source, 0, 0, RT_SIZE, RT_SIZE);
  rtBig.getContext("2d").drawImage(rtSmall, 0, 0, 224, 224);
  return tf.tidy(() => {
    const x = tf.expandDims(tf.sub(tf.div(tf.cast(tf.browser.fromPixels(rtBig), "float32"), 127.5), 1), 0);
    const e = tf.squeeze(tf.mean(RT.base.predict(x), [1, 2]));     // 7×7×1280 → 平均成 1280 個數字
    return tf.div(e, tf.norm(e));                                  // 長度統一成 1
  });
}
async function rtEmbedArray(source) { const t = rtEmbed(source); const a = await t.data(); t.dispose(); return Float32Array.from(a); }

function rtImage(src) {
  return new Promise((ok, bad) => { const im = new Image(); im.onload = () => ok(im); im.onerror = bad; im.src = src; });
}

// ---------- 2. 讀原訓練照片的特徵 ----------
// model/train_features.json：{ dim, scale, classes:[...], y:[類別編號...] }
// model/train_features.bin：每張照片 dim 個 0~255 的數字（特徵 ÷ scale × 255）
async function rtLoadFeatures() {
  if (RT.feats) return RT.feats;
  const v = "?v=" + Math.floor(Date.now() / 600000);
  const meta = await (await fetch("model/train_features.json" + v, { cache: "no-cache" })).json();
  const bin = new Uint8Array(await (await fetch("model/train_features.bin" + v, { cache: "no-cache" })).arrayBuffer());
  const X = [];
  for (let i = 0; i < meta.y.length; i++) {
    const row = new Float32Array(meta.dim);
    for (let j = 0; j < meta.dim; j++) row[j] = (bin[i * meta.dim + j] / 255) * meta.scale;
    X.push(row);
  }
  RT.feats = { X, y: meta.y.map((k) => meta.classes[k]) };
  RT.featsFrom = `網站內建（${meta.made || "原訓練照片"}）`;
  return RT.feats;
}

// ---------- 3. 讀審核確認過的回報照片 ----------
async function rtConfirmedPhotos() {
  let list = [];
  if (CONFIG.SHEET_URL) {
    try {
      const d = await (await fetch(CONFIG.SHEET_URL + "?type=train")).json();
      if (Array.isArray(d.train)) list = d.train;
      else RT.oldScript = true;   // 試算表程式還是舊版，拿不到已確認的照片
    } catch (e) { console.warn("讀取雲端重訓照片失敗", e); }
  }
  // 這台裝置自己審核過的也算（沒連雲端時就只有這些）
  getSamples().filter((x) => x.status === "已確認" && x.photo).forEach((x) => { if (!list.some((s) => s.id === x.id)) list.push(x); });
  return list.filter((x) => x.label && x.label !== "其他" && x.photo);
}

// ---------- 4. 訓練 ----------
// 類別 key → 輸出的第幾格（跟 labels.txt 順序一樣，網站其他地方就不用改）
function rtIndexOf(key) { return labels.findIndex((l) => classOf(l).key === classOf(key).key); }

async function rtFit(X, y, w, onEpoch) {
  // w：每張照片要放幾份（回報照片是在真實環境拍的，比較重要，所以多放幾份）
  const XX = [], yy = [];
  X.forEach((r, i) => { for (let t = 0; t < w[i]; t++) { XX.push(r); yy.push(y[i]); } });
  const n = labels.length, dim = XX[0].length;
  const head = tf.sequential({ layers: [
    tf.layers.dense({ inputShape: [dim], units: 100, activation: "relu" }),   // 跟 Teachable Machine 一樣：100 個神經元
    tf.layers.dense({ units: n, activation: "softmax" }),
  ] });
  head.compile({ optimizer: tf.train.adam(CONFIG.RETRAIN.learningRate), loss: "categoricalCrossentropy" });
  const flat = new Float32Array(XX.length * dim); XX.forEach((r, i) => flat.set(r, i * dim));
  const xs = tf.tensor2d(flat, [XX.length, dim]);
  const ys = tf.oneHot(tf.tensor1d(yy, "int32"), n);
  // 每一類的照片數量差很多（例如寶特瓶只有 26 張），所以少的類別每張照片算重一點
  const count = Array(n).fill(0); yy.forEach((k) => count[k]++);
  const classWeight = {}; count.forEach((c, k) => (classWeight[k] = c ? XX.length / (n * c) : 1));
  await head.fit(xs, ys, { epochs: CONFIG.RETRAIN.epochs, batchSize: 64, shuffle: true, classWeight,
    callbacks: { onEpochEnd: (e) => onEpoch && onEpoch(e) } });
  tf.dispose([xs, ys]);
  return head;
}

function rtPredictHead(head, vec) {
  return tf.tidy(() => Array.from(head.predict(tf.tensor2d(vec, [1, vec.length])).dataSync()));
}
const rtArgmax = (p) => p.indexOf(Math.max(...p));

// 用 id 做簡單的雜湊，決定哪些照片留下來當「考試題」（每次都一樣，結果才能比較）
function rtHash(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }

async function rtTrain(reason) {
  if (RT.busy) { RT.again = true; return; }
  if (!CONFIG.RETRAIN.enabled || !window.__ready) return;
  RT.busy = true; RT.again = false;
  try {
    rtSetMsg("準備中…");
    await rtLoadBase();
    const feats = await rtLoadFeatures();
    const photos = await rtLoadShared();
    const key = [labels.join(","), feats.y.length, RT.featsFrom, CONFIG.RETRAIN.epochs, ...photos.map((p) => p.id).sort()].join("|");
    const keyHash = String(rtHash(key));

    // 照片跟上次一樣 → 直接讀存好的模型，不用重練
    if (reason !== "force" && localStorage.getItem("rtKey") === keyHash) {
      try {
        RT.head = await tf.loadLayersModel("indexeddb://snapsort-retrain");
        RT.info = JSON.parse(localStorage.getItem("rtInfo") || "null");
        rtSetMsg(`已載入上次訓練的模型（${new Date(RT.info?.time || Date.now()).toLocaleString()}）`);
        return;
      } catch { /* 沒存到，往下重新訓練 */ }
    }
    if (photos.length < CONFIG.RETRAIN.minPhotos) {
      RT.head = null;
      RT.info = { photos: photos.length, time: Date.now(), notEnough: true };
      rtSetMsg(`已確認的回報照片 ${photos.length} 張，至少要 ${CONFIG.RETRAIN.minPhotos} 張才會重訓（目前用原本的模型）`);
      return;
    }

    // 回報照片的特徵（rtLoadShared 已經算好）
    const fb = RT.shared.filter((m) => rtIndexOf(m.label) >= 0).map((m) => ({ ...m, k: rtIndexOf(m.label) }));
    const baseX = [], baseY = [];
    feats.X.forEach((v, i) => { const k = rtIndexOf(feats.y[i]); if (k >= 0) { baseX.push(v); baseY.push(k); } });
    const W = CONFIG.RETRAIN.feedbackWeight;

    // (a) 小考：留 20% 回報照片不給它學，比較「原模型」和「重訓模型」誰答對比較多
    let test = null;
    const quiz = fb.filter((f) => rtHash(f.id) % 5 === 0), study = fb.filter((f) => rtHash(f.id) % 5 !== 0);
    if (quiz.length >= 3 && study.length) {
      const h = await rtFit(baseX.concat(study.map((f) => f.vec)), baseY.concat(study.map((f) => f.k)),
        baseX.map(() => 1).concat(study.map(() => W)), (e) => rtSetMsg(`小考模型訓練中 ${e + 1}／${CONFIG.RETRAIN.epochs}`));
      let oldOk = 0, newOk = 0;
      for (const f of quiz) {
        if (rtArgmax(rtPredictHead(h, f.vec)) === f.k) newOk++;
        try { if (rtOriginalPredict(await rtImage(f.photo)) === f.k) oldOk++; } catch {}
      }
      h.dispose();
      test = { n: quiz.length, oldOk, newOk };
    }

    // (b) 正式訓練：全部照片一起學
    const head = await rtFit(baseX.concat(fb.map((f) => f.vec)), baseY.concat(fb.map((f) => f.k)),
      baseX.map(() => 1).concat(fb.map(() => W)), (e) => rtSetMsg(`重新訓練中 ${e + 1}／${CONFIG.RETRAIN.epochs}`));
    if (RT.head) RT.head.dispose();
    RT.head = head;
    const perClass = {};
    baseY.forEach((k) => { const c = classOf(labels[k]).key; perClass[c] = perClass[c] || [0, 0]; perClass[c][0]++; });
    fb.forEach((f) => { const c = classOf(labels[f.k]).key; perClass[c] = perClass[c] || [0, 0]; perClass[c][1]++; });
    RT.info = { time: Date.now(), photos: fb.length, base: baseX.length, test, perClass, featsFrom: RT.featsFrom };
    try { await head.save("indexeddb://snapsort-retrain"); localStorage.setItem("rtKey", keyHash); localStorage.setItem("rtInfo", JSON.stringify(RT.info)); } catch {}
    rtSetMsg(`重訓完成！學了 ${baseX.length} 張原訓練照片＋${fb.length} 張回報照片`);
  } catch (e) {
    console.error(e); rtSetMsg("重訓失敗：" + e.message);
  } finally {
    RT.busy = false;
    if (RT.again) rtTrain();
  }
}

// 原本的模型（TFLite）辨識一張回報照片，給小考比較用
function rtOriginalPredict(im) {
  const [, h, w] = inputInfo.shape;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  c.getContext("2d").drawImage(im, 0, 0, w, h);
  return rtArgmax(runModel(c));
}

function rtSetMsg(m) {
  RT.msg = m;
  const el = document.getElementById("rt-status"); if (el) el.textContent = m;
  const pill = document.getElementById("rt-pill"); if (pill) pill.hidden = !rtActive();
}

// 審核按「確認」後，等 5 秒（可能會連續確認好幾張）再自動重訓
function rtSchedule() {
  if (!CONFIG.RETRAIN.enabled) return;
  clearTimeout(RT.timer);
  rtSetMsg("有新確認的照片，5 秒後自動重新訓練…");
  RT.timer = setTimeout(() => rtTrain(), 5000);
}

// ---------- 5. 辨識時要不要用重訓模型 ----------
function rtActive() {
  return !!(RT.head && RT.base && CONFIG.RETRAIN.enabled && rtOn());
}
// vec：畫面的特徵（rtEmbedArray 算好的）
function rtPredict(vec) { return rtPredictHead(RT.head, vec); }

// ---------- 即時自學記憶（KNN）：使用者一糾正，馬上學會 ----------
// 做法：按「拍一下」時，網站把定格的那一刻連續拍 3 張（約 0.15 秒），
// 使用者按「不對」並選了正確物品，就把這 3 張的特徵＋正確類別存進「記憶」。
// 之後辨識時，先跟記憶比：最像的 k 張裡，夠像（相似度 ≥ minSimilarity）而且同一類占 ≥ 75% → 直接用記憶的答案；
// 否則照原本的模型。記憶存在這台裝置（localStorage），重新整理也不會忘。
// 團隊審核確認過的照片也會放進記憶，所以「所有裝置共享」的部分要經過審核，避免有人亂教。
RT.memory = [];   // 這台裝置的糾正：{ id, label, time, vec }
RT.shared = [];   // 雲端審核確認過的照片：{ id, label, vec, photo }
const RT_Q = 0.3; // 特徵存檔時的刻度（特徵最大約 0.26）
function rtPack(vec) { let s = ""; for (const v of vec) s += String.fromCharCode(Math.min(255, Math.round((v / RT_Q) * 255))); return btoa(s); }
function rtUnpack(b64) { const s = atob(b64), v = new Float32Array(s.length); for (let i = 0; i < s.length; i++) v[i] = (s.charCodeAt(i) / 255) * RT_Q; return v; }

function rtLoadMemory() {
  RT.memory = load("memory").map((m) => ({ ...m, vec: rtUnpack(m.v) }));
}
function rtSaveMemory() {
  const list = RT.memory.slice(-CONFIG.MEMORY.max);
  RT.memory = list;
  store("memory", list.map(({ id, label, time, vec }) => ({ id, label, time, v: rtPack(vec) })));
}

// 定格時連拍 3 張（存成小畫布，等使用者糾正時才算特徵）
async function rtGrabFrames() {
  const v = $("video"), side = Math.min(v.videoWidth, v.videoHeight), out = [];
  for (let i = 0; i < CONFIG.MEMORY.frames; i++) {
    const c = document.createElement("canvas"); c.width = c.height = RT_SIZE;
    c.getContext("2d").drawImage(v, (v.videoWidth - side) / 2, (v.videoHeight - side) / 2, side, side, 0, 0, RT_SIZE, RT_SIZE);
    out.push(c);
    if (i < CONFIG.MEMORY.frames - 1) await new Promise((r) => setTimeout(r, 50));
  }
  return out;
}

// 使用者糾正 → 存進記憶（回傳學了幾張）
async function rtRemember(frames, key) {
  if (!CONFIG.MEMORY.enabled || !frames || rtIndexOf(key) < 0) return 0;
  await rtLoadBase();
  for (const c of frames) RT.memory.push({ id: newId(), label: classOf(key).key, time: new Date().toISOString(), vec: await rtEmbedArray(c) });
  rtSaveMemory();
  return frames.length;
}

const rtDot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
// 跟記憶比對：回傳 { probs, conf, label, sim, n } 或 null（沒有夠像的）
function rtRecall(vec) {
  const M = CONFIG.MEMORY, all = RT.memory.concat(RT.shared);
  if (!all.length) return null;
  const near = all.map((m) => ({ m, sim: rtDot(vec, m.vec) })).sort((a, b) => b.sim - a.sim).slice(0, M.k)
    .filter((x) => x.sim >= M.minSimilarity);
  if (near.length < Math.min(M.minMatches, M.k)) return null;
  const probs = labels.map(() => 0);
  near.forEach((x) => { probs[rtIndexOf(x.m.label)] += 1 / near.length; });
  const k = rtArgmax(probs);
  return { probs, conf: probs[k], label: labels[k], sim: near[0].sim, n: near.length };
}

// 讀雲端審核確認過的照片 → 算特徵（算過的存起來，下次不用再算）
async function rtLoadShared() {
  const photos = await rtConfirmedPhotos();
  const cache = load("vecCache", {}), fresh = {}, out = [];
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    let v = cache[p.id];
    if (!v) {
      rtSetMsg(`讀取審核確認的照片 ${i + 1}／${photos.length}`);
      try { await rtLoadBase(); v = rtPack(await rtEmbedArray(await rtImage(p.photo))); } catch { continue; }
    }
    fresh[p.id] = v;
    out.push({ id: p.id, label: classOf(p.label).key, vec: rtUnpack(v), photo: p.photo });
  }
  store("vecCache", fresh);
  RT.shared = CONFIG.MEMORY.useConfirmed ? out : [];
  return out;
}

// 辨識一張畫面要不要用到特徵（有記憶或有重訓模型才需要）
function rtNeedEmbed() { return rtOn() && RT.base && (RT.memory.length + RT.shared.length > 0 || RT.head); }
function rtOn() { return (localStorage.getItem("rtUse") || "auto") === "auto"; }

// 網站啟動時：讀 MobileNet、記憶、雲端確認照片，再看要不要重訓
async function rtStart() {
  try {
    rtLoadMemory();
    await rtLoadBase();
    rtEmbed(rtBig).dispose();   // 先暖機一次，之後糾正時才能很快學會
    if (CONFIG.RETRAIN.enabled) await rtTrain();
    else { await rtLoadShared(); rtSetMsg("整體重訓已關閉（config.js）"); }
  } catch (e) { console.error(e); rtSetMsg("自學功能載入失敗：" + e.message); }
}

// ---------- 6. 換訓練照片：讀 Teachable Machine 專案檔（.tm）→ 算特徵 → 下載 ----------
// 修好訓練照片後，在 Teachable Machine 按「儲存專案到檔案」得到 .tm 檔，選它就會重算特徵。
// 算好會先在這台裝置使用，並下載 train_features.json / .bin，上傳到 GitHub 的 model 資料夾後所有人都會用。
async function rtReadZip(file) {
  const buf = new Uint8Array(await file.arrayBuffer()), dv = new DataView(buf.buffer);
  let e = buf.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("不是 zip / .tm 檔");
  const count = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
  const out = [], dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true), name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (!/\.(jpe?g|png)$/i.test(name)) continue;
    const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
    let data = buf.subarray(start, start + csize);
    if (method === 8) data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    else if (method !== 0) continue;
    // 類別：檔名「類別-!-編號.jpg」（Teachable Machine 專案檔）或「類別/xxx.jpg」（資料夾）
    const base = name.split("/").pop();
    const cls = base.includes("-!-") ? base.split("-!-")[0] : name.split("/").slice(-2, -1)[0];
    if (cls) out.push({ cls, data, type: /png$/i.test(name) ? "image/png" : "image/jpeg" });
  }
  return out;
}

async function rtMakeFeatures(file) {
  const msg = (m) => ($("rt-feat-msg").textContent = m);
  try {
    await rtLoadBase();
    msg("讀取檔案中…");
    const files = await rtReadZip(file);
    if (!files.length) throw new Error("檔案裡找不到照片");
    const classes = [], y = [], X = [];
    for (let i = 0; i < files.length; i++) {
      if (i % 20 === 0) msg(`計算特徵 ${i + 1}／${files.length}`);
      const key = classOf(files[i].cls).key;
      if (rtIndexOf(key) < 0) continue;   // 模型沒有的類別就跳過
      const url = URL.createObjectURL(new Blob([files[i].data], { type: files[i].type }));
      try { X.push(await rtEmbedArray(await rtImage(url))); } finally { URL.revokeObjectURL(url); }
      if (!classes.includes(key)) classes.push(key);
      y.push(classes.indexOf(key));
    }
    const dim = X[0].length, scale = Math.max(...X.map((r) => Math.max(...r)));
    const bin = new Uint8Array(X.length * dim);
    X.forEach((r, i) => r.forEach((v, j) => (bin[i * dim + j] = Math.round((v / scale) * 255))));
    const counts = {}; y.forEach((k) => (counts[classes[k]] = (counts[classes[k]] || 0) + 1));
    const made = `${file.name}・${X.length} 張・${new Date().toLocaleDateString()}`;
    const meta = { dim, scale, classes, y, counts, made };
    saveFile(new Blob([JSON.stringify(meta)], { type: "application/json" }), "train_features.json");
    setTimeout(() => saveFile(new Blob([bin], { type: "application/octet-stream" }), "train_features.bin"), 500);
    // 先在這台裝置用新的特徵重訓
    RT.feats = { X: X.map((r) => Float32Array.from(r, (v) => Math.round((v / scale) * 255) / 255 * scale)), y: y.map((k) => classes[k]) };
    RT.featsFrom = `這台裝置剛算的（${made}）`;
    msg(`完成！${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join("、")}。已下載兩個檔案，上傳到 GitHub 的 model 資料夾（取代舊的）後所有人都會用。現在先在這台裝置重新訓練…`);
    await rtTrain("force");
    renderRetrain();
  } catch (e) { console.error(e); msg("失敗：" + e.message); }
}

// ---------- 7. 儀表板 ----------
function renderRetrain() {
  if (!$("rt-box")) return;
  $("rt-use").value = localStorage.getItem("rtUse") || "auto";
  $("rt-status").textContent = RT.msg;
  // 即時自學記憶：每一類記了幾張
  const cnt = {}; RT.memory.forEach((m) => (cnt[m.label] = (cnt[m.label] || 0) + 1));
  $("rt-memory").innerHTML = `<p>🧠 這台裝置的自學記憶：${RT.memory.length} 張畫面` +
    (RT.memory.length ? `（${Object.entries(cnt).map(([k, n]) => `${nameOf(k)} ${n}`).join("、")}）` : "（還沒有，辨識頁按「❌ 不對」選正確物品就會學）") +
    `<br>☁️ 團隊審核確認、所有裝置共享的照片：${RT.shared.length} 張</p>`;
  const i = RT.info;
  let html = "";
  if (RT.oldScript) html += `<p class="rt-warn">⚠️ Google 試算表的程式還是舊版，拿不到雲端已確認的照片。請照 README「AI 自動重訓」一節更新 Apps Script（網址不會變）。</p>`;
  if (i && !i.notEnough) {
    html += `<p>上次訓練：${new Date(i.time).toLocaleString()}・原訓練照片 ${i.base} 張＋已確認回報照片 ${i.photos} 張</p>`;
    if (i.test) {
      html += `<p><b>小考結果</b>（${i.test.n} 張回報照片故意不給它學，拿來考試）：原本的模型答對 ${i.test.oldOk} 張，重訓模型答對 ${i.test.newOk} 張。<br>
        <span class="muted">注意：這些照片本來就是原模型認錯或沒把握的，所以原模型的分數一定偏低；照片越多，這個比較越可信。</span></p>`;
    } else html += `<p class="muted">已確認的回報照片再多一點（至少約 15 張）就會自動做小考，比較重訓前後的差別。</p>`;
    html += `<table class="tbl"><thead><tr><th>類別</th><th>原訓練照片</th><th>回報照片</th></tr></thead><tbody>` +
      Object.entries(i.perClass).map(([k, [a, b]]) => `<tr><td>${nameOf(k)}</td><td>${a}${a < 60 ? " ⚠️" : ""}</td><td>${b}</td></tr>`).join("") +
      `</tbody></table><p class="muted">⚠️ = 原訓練照片少於 60 張，這一類最容易認錯，最好在 Teachable Machine 多拍一些（不同背景、角度、光線）。</p>`;
  }
  $("rt-detail").innerHTML = html;
}

$("rt-use").onchange = (e) => { localStorage.setItem("rtUse", e.target.value); recent = []; recentSrc = []; rtSetMsg(RT.msg); };
$("rt-clear").onclick = () => { if (confirm("確定清除這台裝置的自學記憶？")) { RT.memory = []; rtSaveMemory(); recent = []; recentSrc = []; renderRetrain(); } };
$("rt-now").onclick = () => rtTrain("force").then(renderRetrain);
$("rt-feat").onchange = (e) => { if (e.target.files[0]) rtMakeFeatures(e.target.files[0]); e.target.value = ""; };
