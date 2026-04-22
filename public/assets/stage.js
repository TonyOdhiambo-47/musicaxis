// MusicAxis — desktop stage
// Roles:
//  - generate a session id + QR so a phone can join
//  - hold a WebSocket to the relay, consume orientation events
//  - run the Tone.js sound engine (4 instruments, master chain, MediaRecorder)
//  - translate {alpha, beta, gamma} into a scale-locked note with hysteresis
//  - render the live visualizer + recording library
// Side note: all audio lives here. The phone only sends tilt.

import { SCALES, instrumentFactory, MasterBus } from "/assets/engine.js";

// ─── DOM ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const dom = {
  body: document.body,
  dateline: $("dateline"),
  metaInstrument: $("meta-instrument"),
  metaScale: $("meta-scale"),
  metaSession: $("meta-session"),
  startGate: $("start-gate"),
  startBtn: $("start-btn"),
  qrWrap: $("qr-wrap"),
  qrCanvas: $("qr-canvas"),
  qrUrl: $("qr-url"),
  vizWrap: $("viz-wrap"),
  vizFork: $("viz-fork"),
  vizCorona: $("viz-corona"),
  vizHalo: $("viz-halo"),
  vizNoteRing: $("viz-noteRing"),
  vizNote: $("viz-note"),
  vizValues: $("viz-values"),
  connDot: $("conn-dot"),
  connText: $("conn-text"),
  instButtons: document.querySelectorAll(".inst"),
  scaleButtons: document.querySelectorAll(".chip"),
  bpm: $("bpm"),
  bpmVal: $("bpm-val"),
  recBtn: $("rec-btn"),
  recLabel: $("rec-label"),
  recTime: $("rec-time"),
  recWaveLine: $("rec-wave-line"),
  library: $("library"),
  loader: $("loader"),
  loaderTitle: $("loader-title"),
  loaderSub: $("loader-sub"),
  loaderFill: $("loader-fill"),
};

// ─── Dateline + entry animation ─────────────────────────────────────────
(function setDateline() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yy = String(d.getFullYear());
  dom.dateline.textContent = `${yy} · ${mm} · ${dd}`;
})();
requestAnimationFrame(() => dom.body.classList.replace("pre-enter", "entered"));

// ─── Session + QR ───────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const sessionId = params.get("s") || genId();
history.replaceState({}, "", `${location.pathname}?s=${sessionId}`);
dom.metaSession.textContent = `SESSION · ${sessionId}`;

function genId() {
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr)).replace(/[+/=]/g, "").slice(0, 8);
}

async function renderQR() {
  const host = location.host; // already includes port
  const proto = location.protocol;
  const url = `${proto}//${host}/play?s=${sessionId}`;
  dom.qrUrl.textContent = url;
  dom.qrCanvas.innerHTML = "";
  const canvas = document.createElement("canvas");
  dom.qrCanvas.appendChild(canvas);
  await QRCode.toCanvas(canvas, url, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 220,
    color: { dark: "#0b0a08", light: "#f2e6cd00" },
  });
}

// ─── State ──────────────────────────────────────────────────────────────
const state = {
  currentInst: "piano",
  scale: "minor_pentatonic",
  bpm: 96,
  orient: { alpha: 0, beta: 0, gamma: 0 },
  zoneIdx: -1,
  lastTriggerAt: 0,
  lastNoteReleaseTimer: null,
  paired: false,
  engineReady: false,
  wsReady: false,
};

// Expose for debugging
window.__musicaxis = state;

// ─── WebSocket ──────────────────────────────────────────────────────────
let ws;
function connectWS() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onopen = () => {
    state.wsReady = true;
    setStatus("open", "hall open · waiting for a phone to join");
    ws.send(JSON.stringify({ type: "join", role: "stage", session: sessionId }));
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleRelayMsg(msg);
  };
  ws.onclose = () => {
    state.wsReady = false;
    state.paired = false;
    setStatus("error", "disconnected · reopening…");
    showQR();
    setTimeout(connectWS, 1500);
  };
  ws.onerror = () => {}; // swallow, onclose will retry
}

function handleRelayMsg(msg) {
  if (msg.type === "presence") {
    if (msg.status === "controller-connected" || (msg.status === "paired" && msg.stages > 0)) {
      state.paired = true;
      showVisualizer();
      setStatus("paired", "phone connected · tilt to play");
    } else if (msg.status === "controller-disconnected") {
      state.paired = false;
      showQR();
      setStatus("open", "phone disconnected · scan to reconnect");
    }
  } else if (msg.type === "orient") {
    onOrientation(msg);
  } else if (msg.type === "tap") {
    // optional: user can tap the phone to force-trigger current zone
    forceTrigger();
  }
}

function setStatus(stateName, text) {
  dom.connDot.dataset.state = stateName;
  dom.connText.textContent = text;
}
function showQR() {
  dom.qrWrap.hidden = false;
  dom.vizWrap.hidden = true;
  dom.startGate.hidden = !dom.startGate.hidden && false;
  if (state.engineReady) dom.startGate.hidden = true;
}
function showVisualizer() {
  dom.qrWrap.hidden = true;
  dom.vizWrap.hidden = false;
  dom.startGate.hidden = true;
}

// ─── Audio engine ───────────────────────────────────────────────────────
let master;               // MasterBus
let instruments = {};     // built lazily
let activeInst = null;

async function startEngine() {
  if (state.engineReady) return;
  dom.startBtn.disabled = true;

  // Tone.start() must be in a user gesture. This handler IS the gesture.
  await Tone.start();
  Tone.Destination.volume.value = -6;

  master = new MasterBus();

  // Instrument loaders with a small staged progress bar.
  showLoader("Tuning the piano", "loading Salamander samples · about 5 MB");
  setLoader(0.05);

  try {
    instruments.piano = await instrumentFactory.piano((p) => setLoader(0.05 + p * 0.65), master.input);
    setLoader(0.72);
    setLoaderText("Warming the oscillators", "synth · strings");
    instruments.synth = instrumentFactory.synth(master.input);
    instruments.strings = instrumentFactory.strings(master.input);
    setLoader(0.85);
    setLoaderText("Wetting the mallets", "marimba samples");
    instruments.marimba = await instrumentFactory.marimba(master.input);
    setLoader(1.0);
  } catch (err) {
    console.error("engine load failed", err);
    setLoaderText("One instrument stumbled", err?.message || "continuing with what loaded");
  }

  activeInst = instruments[state.currentInst];
  state.engineReady = true;
  hideLoader();

  // Engine ready → show the QR and open the relay
  dom.startGate.hidden = true;
  if (!state.paired) dom.qrWrap.hidden = false;
  await renderQR();
  connectWS();
}

dom.startBtn.addEventListener("click", startEngine, { once: true });

// ─── Loader helpers ─────────────────────────────────────────────────────
function showLoader(title, sub) { dom.loader.hidden = false; setLoaderText(title, sub); setLoader(0); }
function hideLoader() { dom.loader.hidden = true; }
function setLoaderText(title, sub) { dom.loaderTitle.textContent = title; dom.loaderSub.textContent = sub; }
function setLoader(p) { dom.loaderFill.style.width = `${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`; }

// ─── Instrument + scale selection ───────────────────────────────────────
dom.instButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const id = btn.dataset.inst;
    dom.instButtons.forEach((b) => { b.classList.toggle("active", b === btn); b.setAttribute("aria-checked", b === btn); });
    state.currentInst = id;
    dom.metaInstrument.textContent = `INSTR · ${btn.querySelector(".inst-name").textContent.toUpperCase()}`;
    activeInst = instruments[id];
  });
});

dom.scaleButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const id = btn.dataset.scale;
    dom.scaleButtons.forEach((b) => { b.classList.toggle("active", b === btn); b.setAttribute("aria-checked", b === btn); });
    state.scale = id;
    dom.metaScale.textContent = `SCALE · ${btn.textContent.toUpperCase()}`;
    state.zoneIdx = -1;
  });
});

dom.bpm.addEventListener("input", () => {
  state.bpm = parseInt(dom.bpm.value, 10);
  dom.bpmVal.textContent = state.bpm;
  if (window.Tone) Tone.Transport.bpm.value = state.bpm;
});

// ─── Orientation → note mapping ─────────────────────────────────────────
// gamma: -90..90 → index into scale array (with hysteresis)
// beta:  -90..90 → velocity (soft tilt = soft, aggressive = loud)
// alpha: 0..360  → reverb wet amount (0..0.6)
const ZONE_HYSTERESIS = 2.5; // degrees
const AUTO_RELEASE_MS = 800;

function onOrientation(msg) {
  state.orient.alpha = clampAlpha(msg.alpha);
  state.orient.beta = msg.beta;
  state.orient.gamma = msg.gamma;

  updateVisualizer();

  if (!activeInst) return;

  const scale = SCALES[state.scale];
  const n = scale.length;

  // Map gamma (-60..60 is comfortable range) to 0..n-1 with some edge room.
  const raw = (msg.gamma + 60) / 120; // 0..1
  const clamped = Math.max(0, Math.min(0.9999, raw));
  const targetIdx = Math.floor(clamped * n);

  // Hysteresis — only move zones if gamma crosses a 2.5° band past the boundary
  const desired = targetIdx;
  if (state.zoneIdx === -1) {
    state.zoneIdx = desired;
    trigger(scale[desired]);
  } else if (desired !== state.zoneIdx) {
    const boundary = ((desired + (desired > state.zoneIdx ? 0 : 1)) / n) * 120 - 60;
    if (Math.abs(msg.gamma - boundary) > ZONE_HYSTERESIS) {
      state.zoneIdx = desired;
      trigger(scale[desired]);
    }
  }

  // Reverb wet from alpha — smooth
  const wet = Math.max(0, Math.min(0.6, (Math.abs(msg.alpha - 180) / 180) * 0.6));
  if (master) master.setReverb(wet);

  // Master filter opens with strong forward tilt — brightness
  if (master) {
    const forward = Math.max(-60, Math.min(60, msg.beta));
    const t = (forward + 60) / 120; // 0..1
    master.setBrightness(t);
  }
}

function clampAlpha(a) { if (a == null || Number.isNaN(a)) return 0; return ((a % 360) + 360) % 360; }

function betaToVelocity(beta) {
  // -90 (phone face up, soft) … 0 (neutral) … 60 (aggressive push, loud)
  const b = Math.max(-90, Math.min(60, beta));
  const norm = (b + 90) / 150; // 0..1
  return 0.35 + norm * 0.65;   // 0.35..1.0 — never dead silent
}

let lastTriggeredNote = null;
function trigger(note) {
  if (!activeInst || !note) return;
  const now = performance.now();
  if (now - state.lastTriggerAt < 40) return; // ≤25Hz hard cap
  state.lastTriggerAt = now;

  const vel = betaToVelocity(state.orient.beta);

  try {
    if (lastTriggeredNote && activeInst.triggerRelease) {
      activeInst.triggerRelease(lastTriggeredNote);
    }
    activeInst.triggerAttack(note, undefined, vel);
    lastTriggeredNote = note;

    if (state.lastNoteReleaseTimer) clearTimeout(state.lastNoteReleaseTimer);
    state.lastNoteReleaseTimer = setTimeout(() => {
      try { activeInst.triggerRelease(note); } catch {}
      if (lastTriggeredNote === note) lastTriggeredNote = null;
    }, AUTO_RELEASE_MS);

    pulseVisualizer(note, vel);
    dom.vizNote.textContent = note;
  } catch (err) {
    // piano samples may not all be loaded yet — swallow
  }
}

function forceTrigger() {
  const scale = SCALES[state.scale];
  if (state.zoneIdx < 0) return;
  trigger(scale[state.zoneIdx]);
}

// ─── Visualizer ─────────────────────────────────────────────────────────
function updateVisualizer() {
  const { alpha, beta, gamma } = state.orient;
  // Fork tilts with gamma; halo breathes with beta; corona rotates with alpha.
  dom.vizFork.style.transform = `rotate(${gamma * 0.6}deg) scaleY(${1 + beta * 0.002})`;
  dom.vizCorona.setAttribute("transform", `translate(160 160) rotate(${alpha})`);
  const haloScale = 1 + Math.min(1, Math.abs(beta) / 80) * 0.12;
  dom.vizHalo.setAttribute("transform", `translate(160 160) scale(${haloScale}) translate(-160 -160)`);
  dom.vizValues.textContent =
    `α ${alpha.toFixed(0).padStart(3, "·")}  ·  β ${beta.toFixed(0).padStart(3, "·")}  ·  γ ${gamma.toFixed(0).padStart(3, "·")}`;
}

function pulseVisualizer(note, vel) {
  // Note ring bursts then fades
  const ring = dom.vizNoteRing;
  ring.setAttribute("r", "40");
  ring.style.opacity = String(0.4 + vel * 0.5);
  ring.querySelector("circle").setAttribute("r", "40");
  // Force reflow, then animate
  requestAnimationFrame(() => {
    ring.querySelector("circle").setAttribute("r", "140");
    ring.style.opacity = "0";
  });
}

// ─── Recording ──────────────────────────────────────────────────────────
let mediaRec = null;
let recChunks = [];
let recStart = 0;
let recTimerId = null;
let recStream = null;

function recMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg", "audio/mp4"];
  for (const m of candidates) if (window.MediaRecorder?.isTypeSupported?.(m)) return m;
  return "";
}

dom.recBtn.addEventListener("click", async () => {
  if (!state.engineReady) {
    setStatus("error", "tap “Enter the hall” first — the engine is asleep");
    return;
  }
  if (mediaRec && mediaRec.state === "recording") {
    stopRecording();
  } else {
    await startRecording();
  }
});

async function startRecording() {
  if (!master) return;
  recStream = master.getStream();
  const mime = recMimeType();
  try {
    mediaRec = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
  } catch (err) {
    console.error("MediaRecorder failed", err);
    return;
  }
  recChunks = [];
  mediaRec.ondataavailable = (e) => { if (e.data && e.data.size > 0) recChunks.push(e.data); };
  mediaRec.onstop = () => finalizeRecording(mime);
  mediaRec.start(200);
  recStart = performance.now();
  dom.recBtn.setAttribute("aria-pressed", "true");
  dom.recLabel.textContent = "Stop";
  tickRecTimer();
}

function stopRecording() {
  if (!mediaRec) return;
  mediaRec.stop();
  dom.recBtn.setAttribute("aria-pressed", "false");
  dom.recLabel.textContent = "Record";
  if (recTimerId) { cancelAnimationFrame(recTimerId); recTimerId = null; }
}

function tickRecTimer() {
  const t = (performance.now() - recStart) / 1000;
  const mm = Math.floor(t / 60).toString().padStart(2, "0");
  const ss = (t % 60).toFixed(1).padStart(4, "0");
  dom.recTime.textContent = `${mm}:${ss}`;
  // Waveform: poll master RMS and append to polyline
  const rms = master?.getRms?.() ?? 0;
  pushWave(rms);
  recTimerId = requestAnimationFrame(tickRecTimer);
}

const waveBuf = new Array(160).fill(14);
function pushWave(rms) {
  const y = 14 - Math.min(13, rms * 48);
  waveBuf.shift(); waveBuf.push(y);
  let points = "";
  for (let i = 0; i < waveBuf.length; i++) points += `${i},${waveBuf[i].toFixed(2)} `;
  dom.recWaveLine.setAttribute("points", points.trim());
}

function finalizeRecording(mime) {
  const type = mime || "audio/webm";
  const blob = new Blob(recChunks, { type });
  const url = URL.createObjectURL(blob);
  const stamp = new Date();
  const ts = `${stamp.getFullYear()}${pad(stamp.getMonth()+1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
  const dur = ((performance.now() - recStart) / 1000);
  const ext = type.includes("ogg") ? "ogg" : type.includes("mp4") ? "m4a" : "webm";
  const filename = `musicaxis_${ts}.${ext}`;

  // Auto-download
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();

  addToLibrary({ url, filename, blob, duration: dur, instrument: state.currentInst, scale: state.scale, at: stamp });
  recChunks = [];
  dom.recTime.textContent = "00:00.0";
}

function pad(n) { return String(n).padStart(2, "0"); }

const library = [];
function addToLibrary(entry) {
  library.unshift(entry);
  renderLibrary();
}

function renderLibrary() {
  dom.library.innerHTML = "";
  if (library.length === 0) {
    dom.library.innerHTML = `<li class="library-empty">the ledger is empty · record something worth remembering</li>`;
    return;
  }
  library.forEach((e, i) => {
    const li = document.createElement("li");
    li.className = "lib-item";
    const num = String(library.length - i).padStart(2, "0");
    const mm = Math.floor(e.duration / 60).toString().padStart(2, "0");
    const ss = (e.duration % 60).toFixed(1).padStart(4, "0");
    const time = e.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const instName = instrumentLabel(e.instrument);
    li.innerHTML = `
      <span class="lib-num">${num}</span>
      <div class="lib-body">
        <span class="lib-title">${e.filename}</span>
        <span class="lib-sub">${time} · ${mm}:${ss} · ${instName}</span>
      </div>
      <button class="lib-btn play" data-playing="false">Play</button>
      <a class="lib-btn" href="${e.url}" download="${e.filename}">Save</a>
    `;
    const playBtn = li.querySelector(".lib-btn.play");
    let audio = null;
    playBtn.addEventListener("click", () => {
      if (!audio) {
        audio = new Audio(e.url);
        audio.addEventListener("ended", () => { playBtn.dataset.playing = "false"; playBtn.textContent = "Play"; });
      }
      if (audio.paused) { audio.play(); playBtn.dataset.playing = "true"; playBtn.textContent = "Pause"; }
      else { audio.pause(); playBtn.dataset.playing = "false"; playBtn.textContent = "Play"; }
    });
    dom.library.appendChild(li);
  });
}

function instrumentLabel(id) {
  return { piano: "Grand Piano", synth: "Analog Synth", strings: "Strings Hall", marimba: "Marimba" }[id] || id;
}

// ─── First paint niceties ───────────────────────────────────────────────
setStatus("idle", "waiting for the hall to open…");
