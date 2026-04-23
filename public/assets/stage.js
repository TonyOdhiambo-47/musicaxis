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
  debugLine: $("debug-line"),
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
  holding: false,
  engineReady: false,
  paired: false,
  lastTriggerAt: 0,
  inboundFrames: 0,
  lastInboundSecondAt: performance.now(),
  secondFrameCount: 0,
  wsRxPerSecond: 0,
  lastNote: "—",
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
    renderDebug();
    ws.send(JSON.stringify({ type: "join", role: "stage", session: sid }));
  };
  ws.onmessage = (e) => {
    countInbound();
    let m; try { m = JSON.parse(e.data); } catch { return; }
    const flipToViz = () => {
      if (!state.paired) {
        state.paired = true;
        dom.qrWrap.hidden = true;
        dom.vizWrap.hidden = false;
        setStatus("paired", "phone connected");
      }
    };
    if (m.type === "presence") {
      if (m.status === "controller-connected" || (m.status === "paired" && m.peers > 0)) {
        flipToViz();
      } else if (m.status === "controller-disconnected") {
        state.paired = false;
        dom.qrWrap.hidden = false;
        dom.vizWrap.hidden = true;
        setStatus("open", "phone disconnected");
      }
    } else if (m.type === "orient") {
      flipToViz();
      onOrient(m);
    } else if (m.type === "down") {
      flipToViz();
      // Latest orientation rides along on the down msg.
      state.orient.alpha = clampAlpha(m.alpha);
      state.orient.beta = m.beta || 0;
      state.orient.gamma = m.gamma || 0;
      updateViz();
      holdStart();
    } else if (m.type === "up") {
      holdEnd();
    } else if (m.type === "tap") {
      flipToViz();
      holdStart();
      setTimeout(holdEnd, 320);
    }
  };
  ws.onclose = () => {
    setStatus("error", "disconnected, retrying…");
    renderDebug();
    setTimeout(connectWS, 1500);
  };
  ws.onerror = () => {};
}

function setStatus(s, txt) { dom.dot.dataset.state = s; dom.status.textContent = txt; }
function countInbound() {
  state.inboundFrames += 1;
  state.secondFrameCount += 1;
  const now = performance.now();
  const elapsed = now - state.lastInboundSecondAt;
  if (elapsed >= 1000) {
    state.wsRxPerSecond = state.secondFrameCount / (elapsed / 1000);
    state.secondFrameCount = 0;
    state.lastInboundSecondAt = now;
  }
  renderDebug();
}
function renderDebug() {
  if (!dom.debugLine) return;
  const wsState = !ws ? "closed" : ws.readyState === WebSocket.OPEN ? "open" : "closed";
  dom.debugLine.textContent = `ws=${wsState} inbound=${state.inboundFrames} frames ws-rx/s=${state.wsRxPerSecond.toFixed(1)} last-note=${state.lastNote}`;
}

async function renderQR() {
  // If we're at localhost, ask the server for a LAN-reachable hostname so
  // the phone can actually hit this machine over Wi-Fi.
  let host = location.host;
  if (/^(localhost|127\.0\.0\.1|::1)/i.test(host)) {
    try {
      const r = await fetch("/api/whoami").then((x) => x.json());
      if (r?.lan) host = `${r.lan}:${r.port || location.port || 3000}`;
    } catch {}
  }
  const url = `${location.protocol}//${host}/play?s=${sid}`;
  dom.qrUrl.textContent = url;
  dom.qr.innerHTML = "";
  try {
    // qrcode-generator UMD: window.qrcode(typeNumber, errorCorrectionLevel)
    const qr = window.qrcode(0, "M");
    qr.addData(url);
    qr.make();
    const dataUrl = qr.createDataURL(6, 2); // cellSize=6, margin=2
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

// Test note — proves audio chain works without needing a phone.
document.getElementById("test-btn")?.addEventListener("click", () => {
  if (!activeInst) { setStatus("error", "tap Start first"); return; }
  try {
    activeInst.triggerAttack("A4", undefined, 0.8);
    setTimeout(() => { try { activeInst.triggerRelease("A4"); } catch {} }, 600);
    dom.note.textContent = "A4";
  } catch (e) { console.error(e); }
});

// inst/scale pills
dom.insts.forEach((b) => b.addEventListener("click", () => {
  dom.insts.forEach((x) => x.classList.toggle("active", x === b));
  state.currentInst = b.dataset.inst;
  activeInst = instruments[state.currentInst] || instruments.synth || activeInst;
}));
dom.scales.forEach((b) => b.addEventListener("click", () => {
  dom.scales.forEach((x) => x.classList.toggle("active", x === b));
  state.scale = b.dataset.scale;
}));

// ─── Orientation / note mapping ─────────────────────────────────
// γ (-60..60) picks the scale index · β opens the master filter
// · α swells reverb. Notes fire on phone TAP (down/up); while held,
// rotating slides through zones seamlessly.
function clampAlpha(a) { if (a == null || Number.isNaN(a)) return 0; return ((a % 360) + 360) % 360; }

function onOrient(msg) {
  state.orient.alpha = clampAlpha(msg.alpha);
  state.orient.beta = msg.beta || 0;
  state.orient.gamma = msg.gamma || 0;
  updateViz();
  pushPreview();
  if (state.holding) slideToCurrentZone();
  if (master) {
    const wet = Math.min(0.5, Math.abs(state.orient.alpha - 180) / 180 * 0.5);
    master.setReverb(wet);
    const t = (Math.max(-60, Math.min(60, state.orient.beta)) + 60) / 120;
    master.setBrightness(t);
  }
}

function updateViz() {
  const x = Math.max(-1, Math.min(1, state.orient.gamma / 60)) * 70;
  const y = -Math.max(-1, Math.min(1, state.orient.beta / 60)) * 70;
  dom.vizDot.style.transform = `translate(${x}px, ${y}px)`;
  dom.values.textContent = `α ${Math.round(state.orient.alpha)} · β ${Math.round(state.orient.beta)} · γ ${Math.round(state.orient.gamma)}`;
}

// γ ∈ [-80, 80] → 0..scale.length-1. Using β (pitch) too would feel
// confusing, so one axis does the melody and β only brightens the tone.
function currentZoneNote() {
  const scale = SCALES[state.scale];
  const g = Math.max(-80, Math.min(80, state.orient.gamma));
  const raw = (g + 80) / 160;
  const idx = Math.max(0, Math.min(scale.length - 1, Math.floor(raw * scale.length)));
  return scale[idx];
}

// Tell the phone what note it would play right now — so the user can aim.
let previewNote = null;
function pushPreview() {
  if (!state.paired || !ws || ws.readyState !== WebSocket.OPEN) return;
  const note = currentZoneNote();
  if (note === previewNote) return;
  previewNote = note;
  try { ws.send(JSON.stringify({ type: "note", note })); } catch {}
}

function velocity(beta) {
  const b = Math.max(-90, Math.min(60, beta));
  return 0.4 + ((b + 90) / 150) * 0.6;
}

let heldNote = null;
function holdStart() {
  if (!activeInst) return;
  const note = currentZoneNote();
  try {
    if (heldNote) activeInst.triggerRelease?.(heldNote);
    activeInst.triggerAttack(note, undefined, velocity(state.orient.beta));
    heldNote = note;
    state.holding = true;
    state.lastNote = note;
    dom.note.textContent = note;
    renderDebug();
  } catch (e) { console.error("trigger failed", e); }
}
function holdEnd() {
  state.holding = false;
  if (heldNote && activeInst) { try { activeInst.triggerRelease(heldNote); } catch {} }
  heldNote = null;
}
function slideToCurrentZone() {
  if (!activeInst || !state.holding) return;
  const note = currentZoneNote();
  if (note === heldNote) return;
  const now = performance.now();
  if (now - state.lastTriggerAt < 35) return;
  state.lastTriggerAt = now;
  try {
    if (heldNote) activeInst.triggerRelease?.(heldNote);
    activeInst.triggerAttack(note, undefined, velocity(state.orient.beta));
    heldNote = note;
    state.lastNote = note;
    dom.note.textContent = note;
    renderDebug();
  } catch {}
}

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
renderDebug();
