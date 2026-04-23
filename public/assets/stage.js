import { SCALES, instrumentFactory, MasterBus } from "/assets/engine.js";

const $ = (id) => document.getElementById(id);
const dom = {
  startWrap: $("start-wrap"),
  startBtn: $("start-btn"),
  qrWrap: $("qr-wrap"),
  qr: $("qr"),
  qrUrl: $("qr-url"),
  vizWrap: $("viz-wrap"),
  vizDot: $("viz-dot"),
  note: $("note"),
  values: $("values"),
  dot: $("dot"),
  status: $("status"),
  insts: document.querySelectorAll("[data-inst]"),
  scales: document.querySelectorAll("[data-scale]"),
  recBtn: $("rec-btn"),
  recTime: $("rec-time"),
  library: $("library"),
  loader: $("loader"),
  loaderTitle: $("loader-title"),
  loaderFill: $("loader-fill"),
};

const state = {
  currentInst: "piano",
  scale: "minor_pentatonic",
  orient: { alpha: 0, beta: 0, gamma: 0 },
  zoneIdx: -1,
  engineReady: false,
  paired: false,
  lastTriggerAt: 0,
  lastReleaseTimer: null,
};

// session
const sid = new URLSearchParams(location.search).get("s") || genId();
history.replaceState({}, "", `?s=${sid}`);
function genId() {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/[+/=]/g, "").slice(0, 8);
}

// ws
let ws;
function connectWS() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onopen = () => {
    setStatus("open", "waiting for phone");
    ws.send(JSON.stringify({ type: "join", role: "stage", session: sid }));
  };
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === "presence") {
      if (m.status === "controller-connected" || (m.status === "paired" && m.peers > 0)) {
        state.paired = true;
        dom.qrWrap.hidden = true;
        dom.vizWrap.hidden = false;
        setStatus("paired", "phone connected");
      } else if (m.status === "controller-disconnected") {
        state.paired = false;
        dom.qrWrap.hidden = false;
        dom.vizWrap.hidden = true;
        setStatus("open", "phone disconnected");
      }
    } else if (m.type === "orient") {
      onOrient(m);
    } else if (m.type === "tap") {
      forceTrigger();
    }
  };
  ws.onclose = () => {
    setStatus("error", "disconnected, retrying…");
    setTimeout(connectWS, 1500);
  };
  ws.onerror = () => {};
}

function setStatus(s, txt) { dom.dot.dataset.state = s; dom.status.textContent = txt; }

async function renderQR() {
  const url = `${location.protocol}//${location.host}/play?s=${sid}`;
  dom.qrUrl.textContent = url;
  dom.qr.innerHTML = "";
  try {
    const dataUrl = await QRCode.toDataURL(url, {
      errorCorrectionLevel: "M", margin: 1, width: 220,
      color: { dark: "#0b0a08ff", light: "#f1e7d0ff" },
    });
    const img = new Image();
    img.src = dataUrl;
    img.width = 200; img.height = 200;
    img.alt = "scan to join";
    dom.qr.appendChild(img);
  } catch (err) {
    console.error("QR render failed:", err);
    dom.qr.textContent = "(QR failed — use the URL)";
  }
}

// audio
let master, instruments = {}, activeInst = null;
async function startEngine() {
  if (state.engineReady) return;
  dom.startBtn.disabled = true;

  // Hard cap: whatever happens, hide the loader in 7 seconds.
  const bail = setTimeout(() => { dom.loader.hidden = true; }, 7000);

  try {
    await Tone.start();
    Tone.Destination.volume.value = -4;
    master = new MasterBus();

    showLoader("tuning piano", 0.05);
    instruments.piano = await instrumentFactory.piano((p) => setFill(p * 0.7), master.input);
    setFill(0.75);
    dom.loaderTitle.textContent = "warming synths";
    instruments.synth = instrumentFactory.synth(master.input);
    instruments.strings = instrumentFactory.strings(master.input);
    setFill(0.9);
    dom.loaderTitle.textContent = "loading marimba";
    instruments.marimba = await instrumentFactory.marimba(master.input);
    setFill(1);
  } catch (err) {
    console.error("engine load error:", err);
  } finally {
    clearTimeout(bail);
    activeInst = instruments[state.currentInst] || instruments.synth || null;
    state.engineReady = true;
    dom.loader.hidden = true;
    dom.startWrap.hidden = true;
    dom.qrWrap.hidden = false;
    try { await renderQR(); } catch (e) { console.error(e); }
    connectWS();
  }
}
function showLoader(title, p) { dom.loader.hidden = false; dom.loaderTitle.textContent = title; setFill(p); }
function setFill(p) { dom.loaderFill.style.width = `${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`; }

dom.startBtn.addEventListener("click", () => { startEngine().catch(console.error); }, { once: true });

// inst/scale pills
dom.insts.forEach((b) => b.addEventListener("click", () => {
  dom.insts.forEach((x) => x.classList.toggle("active", x === b));
  state.currentInst = b.dataset.inst;
  activeInst = instruments[state.currentInst];
}));
dom.scales.forEach((b) => b.addEventListener("click", () => {
  dom.scales.forEach((x) => x.classList.toggle("active", x === b));
  state.scale = b.dataset.scale;
  state.zoneIdx = -1;
}));

// orientation → note
const HYST = 2.5;
const AUTO_RELEASE = 800;
function onOrient(msg) {
  state.orient.alpha = ((msg.alpha || 0) % 360 + 360) % 360;
  state.orient.beta = msg.beta || 0;
  state.orient.gamma = msg.gamma || 0;

  // viz: move the dot around the ring based on gamma + beta
  const x = Math.max(-1, Math.min(1, state.orient.gamma / 60)) * 70;
  const y = -Math.max(-1, Math.min(1, state.orient.beta / 60)) * 70;
  dom.vizDot.style.transform = `translate(${x}px, ${y}px)`;
  dom.values.textContent = `α ${Math.round(state.orient.alpha)} · β ${Math.round(state.orient.beta)} · γ ${Math.round(state.orient.gamma)}`;

  if (!activeInst) return;
  const scale = SCALES[state.scale];
  const n = scale.length;
  const raw = (state.orient.gamma + 60) / 120;
  const targetIdx = Math.max(0, Math.min(n - 1, Math.floor(raw * n)));

  if (state.zoneIdx === -1) {
    state.zoneIdx = targetIdx;
    trigger(scale[targetIdx]);
  } else if (targetIdx !== state.zoneIdx) {
    const zw = 120 / n;
    const centre = (state.zoneIdx + 0.5) * zw - 60;
    if (Math.abs(state.orient.gamma - centre) > zw / 2 + HYST) {
      state.zoneIdx = targetIdx;
      trigger(scale[targetIdx]);
    }
  }

  if (master) {
    const wet = Math.min(0.5, Math.abs(state.orient.alpha - 180) / 180 * 0.5);
    master.setReverb(wet);
    const t = (Math.max(-60, Math.min(60, state.orient.beta)) + 60) / 120;
    master.setBrightness(t);
  }
}

function velocity(beta) {
  const b = Math.max(-90, Math.min(60, beta));
  return 0.35 + ((b + 90) / 150) * 0.65;
}

let lastNote = null;
function trigger(note) {
  if (!activeInst || !note) return;
  const now = performance.now();
  if (now - state.lastTriggerAt < 40) return;
  state.lastTriggerAt = now;
  try {
    if (lastNote) activeInst.triggerRelease?.(lastNote);
    activeInst.triggerAttack(note, undefined, velocity(state.orient.beta));
    lastNote = note;
    dom.note.textContent = note;
    if (state.lastReleaseTimer) clearTimeout(state.lastReleaseTimer);
    state.lastReleaseTimer = setTimeout(() => { try { activeInst.triggerRelease(note); } catch {}; if (lastNote === note) lastNote = null; }, AUTO_RELEASE);
  } catch {}
}
function forceTrigger() { if (state.zoneIdx >= 0) trigger(SCALES[state.scale][state.zoneIdx]); }

// recording
let rec, chunks = [], recStart = 0, recTimer = null;
dom.recBtn.addEventListener("click", async () => {
  if (!state.engineReady) { setStatus("error", "tap Start first"); return; }
  if (rec && rec.state === "recording") stopRec(); else startRec();
});
function recMime() {
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"])
    if (window.MediaRecorder?.isTypeSupported?.(m)) return m;
  return "";
}
function startRec() {
  const stream = master.getStream();
  const mime = recMime();
  try { rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); } catch { return; }
  chunks = [];
  rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  rec.onstop = () => finalizeRec(mime);
  rec.start(200);
  recStart = performance.now();
  dom.recBtn.setAttribute("aria-pressed", "true");
  dom.recBtn.textContent = "Stop";
  tickRec();
}
function stopRec() {
  rec.stop();
  dom.recBtn.setAttribute("aria-pressed", "false");
  dom.recBtn.textContent = "Record";
  if (recTimer) cancelAnimationFrame(recTimer);
}
function tickRec() {
  const t = (performance.now() - recStart) / 1000;
  const mm = Math.floor(t / 60).toString().padStart(2, "0");
  const ss = (t % 60).toFixed(1).padStart(4, "0");
  dom.recTime.textContent = `${mm}:${ss}`;
  recTimer = requestAnimationFrame(tickRec);
}
function finalizeRec(mime) {
  const type = mime || "audio/webm";
  const blob = new Blob(chunks, { type });
  const url = URL.createObjectURL(blob);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const ext = type.includes("ogg") ? "ogg" : type.includes("mp4") ? "m4a" : "webm";
  const filename = `musicaxis_${ts}.${ext}`;
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  addLib({ url, filename });
  chunks = [];
  dom.recTime.textContent = "00:00.0";
}
function addLib(entry) {
  const empty = dom.library.querySelector(".empty");
  if (empty) empty.remove();
  const li = document.createElement("li");
  li.className = "lib-item";
  li.innerHTML = `<span class="name">${entry.filename}</span><button>Play</button><a href="${entry.url}" download="${entry.filename}">Save</a>`;
  let audio = null;
  li.querySelector("button").addEventListener("click", (ev) => {
    if (!audio) { audio = new Audio(entry.url); audio.onended = () => ev.target.textContent = "Play"; }
    if (audio.paused) { audio.play(); ev.target.textContent = "Pause"; }
    else { audio.pause(); ev.target.textContent = "Play"; }
  });
  dom.library.prepend(li);
}

setStatus("idle", "idle");
