import { SCALES, SCALE_ROOT, instrumentFactory, MasterBus, DroneBed } from "/assets/engine.js";
import { SONGBOOK } from "/assets/songbook.js";

const $ = (id) => document.getElementById(id);
const dom = {
  startWrap: $("start-wrap"),
  startBtn: $("start-btn"),
  qrWrap: $("qr-wrap"),
  qr: $("qr"),
  qrUrl: $("qr-url"),
  vizWrap: $("viz-wrap"),
  stripCells: $("strip-cells"),
  stripCurrent: $("strip-current"),
  stripTarget: $("strip-target"),
  octLine: $("oct-line"),
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
  currentInst: "synth",
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
        renderStripCells();
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
let master, drone, instruments = {}, activeInst = null;
let droneTimeout = null;
async function startEngine() {
  if (state.engineReady) return;
  dom.startBtn.disabled = true;

  // Hard cap: whatever happens, hide the loader in 7 seconds.
  const bail = setTimeout(() => { dom.loader.hidden = true; }, 7000);

  try {
    await Tone.start();
    Tone.Destination.volume.value = -4;
    master = new MasterBus();
    drone = new DroneBed(master.input);
    drone.setRoot(SCALE_ROOT[state.scale] || "A");

    showLoader("tuning piano", 0.05);
    instruments.piano = await instrumentFactory.piano((p) => setFill(p * 0.7), master.input);
    setFill(0.75);
    dom.loaderTitle.textContent = "warming synths";
    instruments.synth = instrumentFactory.synth(master.input);
    instruments.strings = instrumentFactory.strings(master.input);
    setFill(0.82);
    dom.loaderTitle.textContent = "stringing guitar";
    instruments.guitar = await instrumentFactory.guitar(master.input);
    setFill(0.93);
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
  previewKey = "";
  renderStripCells();
  pushPreview();
  if (drone) drone.setRoot(SCALE_ROOT[state.scale] || "A");
  if (song.active) songStop();
}));

// ─── Songbook / guide mode ────────────────────────────────────────────
const song = { active: null, stepIdx: 0, lastAdvance: 0 };
const songPick = document.getElementById("song-pick");
const songNow = document.getElementById("song-now");
const songTitle = document.getElementById("song-title");
const songStep = document.getElementById("song-step");
const songTotal = document.getElementById("song-total");
const songHint = document.getElementById("song-hint");

(function populateSongs() {
  if (!songPick) return;
  for (const [id, s] of Object.entries(SONGBOOK)) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = `${s.name}  ·  ${s.tag}`;
    songPick.appendChild(opt);
  }
  songPick.addEventListener("change", () => {
    const id = songPick.value;
    if (!id) { songStop(); return; }
    songStart(id);
  });
})();

function songStart(id) {
  const s = SONGBOOK[id];
  if (!s) return;
  song.active = s;
  song.stepIdx = 0;
  // auto-switch scale + drone root
  state.scale = s.scale;
  dom.scales.forEach((b) => b.classList.toggle("active", b.dataset.scale === s.scale));
  if (drone) drone.setRoot(SCALE_ROOT[s.scale] || "A");
  songNow.hidden = false;
  songHint.hidden = false;
  songTitle.textContent = s.name;
  songTotal.textContent = s.steps.length;
  songStep.textContent = 0;
  previewKey = "";
  renderStripCells();
  pushPreview();
  updateTargetHint();
}
function songStop() {
  song.active = null;
  song.stepIdx = 0;
  songNow.hidden = true;
  songHint.hidden = true;
  if (songPick) songPick.value = "";
  previewKey = "";
  pushPreview();
}
function songCurrentTarget() {
  if (!song.active) return null;
  const step = song.active.steps[song.stepIdx];
  if (!step) return null;
  const [idx, octShift] = step;
  const pitch = SCALES[song.active.scale][idx];
  const octave = BASE_OCTAVE + octShift;
  // The exact γ angle that picks this scale index (zone centre)
  const scale = SCALES[song.active.scale];
  const zw = (2 * GAMMA_RANGE) / scale.length;
  const gamma = (idx + 0.5) * zw - GAMMA_RANGE;
  return { idx, pitch, octave, note: `${pitch}${octave}`, gamma: Math.round(gamma) };
}
// ─── Paste-your-own-tab parser ────────────────────────────────────────
// Accepts "C4 D#4 E4 G4", "C4,D#4,E4", "C D# E G" (defaults to octave 4),
// or a newline-separated list. Everything that doesn't match a note is ignored.
function parsePastedNotes(raw) {
  if (!raw) return [];
  const tokens = raw
    .replace(/[|()\[\]\-_.,;:/]+/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const re = /^([A-Ga-g])([#b]?)(\d)?$/;
  const out = [];
  for (const tok of tokens) {
    const m = re.exec(tok);
    if (!m) continue;
    let pc = m[1].toUpperCase();
    if (m[2] === "#") pc += "#";
    if (m[2] === "b") {
      // convert flats to sharps so they match chromatic scale keys
      const enh = { Cb: "B", Db: "C#", Eb: "D#", Fb: "E", Gb: "F#", Ab: "G#", Bb: "A#" };
      pc = enh[pc + "b"] || pc;
    }
    const oct = m[3] ? parseInt(m[3], 10) : 4;
    const chromatic = SCALES.chromatic;
    const idx = chromatic.indexOf(pc);
    if (idx < 0) continue;
    out.push([idx, oct - BASE_OCTAVE, 1]);
  }
  return out;
}

function usePastedSong() {
  const ta = document.getElementById("paste-box");
  if (!ta) return;
  const steps = parsePastedNotes(ta.value);
  if (steps.length === 0) return;
  const custom = {
    name: "Your paste",
    tag: `${steps.length} notes · chromatic`,
    scale: "chromatic",
    bpm: 100,
    steps,
  };
  SONGBOOK.__custom = custom;
  if (songPick) {
    let opt = songPick.querySelector('option[value="__custom"]');
    if (!opt) {
      opt = document.createElement("option");
      opt.value = "__custom";
      opt.textContent = `★ your pasted tab (${steps.length} notes)`;
      songPick.appendChild(opt);
    } else {
      opt.textContent = `★ your pasted tab (${steps.length} notes)`;
    }
    songPick.value = "__custom";
  }
  songStart("__custom");
}

document.getElementById("paste-btn")?.addEventListener("click", usePastedSong);

function songAdvanceIfMatched() {
  if (!song.active) return;
  const tgt = songCurrentTarget();
  if (!tgt) return;
  const got = currentZoneInfo();
  if (got.idx === tgt.idx && got.octave === tgt.octave) {
    song.stepIdx = Math.min(song.stepIdx + 1, song.active.steps.length);
    songStep.textContent = song.stepIdx;
    if (song.stepIdx >= song.active.steps.length) {
      songTitle.textContent = `${song.active.name} ✓ complete`;
      setTimeout(songStop, 3000);
    }
    previewKey = "";
    pushPreview();
  }
}

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
  // Slide the amber "current" dot along the strip as a percent of γ range.
  const g = Math.max(-GAMMA_RANGE, Math.min(GAMMA_RANGE, state.orient.gamma));
  const pct = ((g + GAMMA_RANGE) / (2 * GAMMA_RANGE)) * 100;
  if (dom.stripCurrent) dom.stripCurrent.style.left = `${pct.toFixed(2)}%`;

  // Highlight the current scale cell
  const cur = currentZoneInfo();
  const cells = dom.stripCells?.children;
  if (cells) {
    const tgt = songCurrentTarget?.();
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      c.classList.toggle("active", i === cur.idx);
      c.classList.toggle("hit", !!tgt && i === tgt.idx && cur.idx === tgt.idx && cur.octave === tgt.octave);
    }
  }

  // Red target dot + text indicator
  updateTargetHint();

  dom.values.textContent = `α ${Math.round(state.orient.alpha)} · β ${Math.round(state.orient.beta)} · γ ${Math.round(state.orient.gamma)}`;
}

function updateTargetHint() {
  const tgt = songCurrentTarget?.();
  if (!tgt || !dom.stripTarget) {
    if (dom.stripTarget) dom.stripTarget.hidden = true;
    if (dom.octLine) dom.octLine.textContent = `oct ${currentZoneInfo().octave}`;
    return;
  }
  const tgtPct = ((tgt.gamma + GAMMA_RANGE) / (2 * GAMMA_RANGE)) * 100;
  dom.stripTarget.hidden = false;
  dom.stripTarget.style.left = `${tgtPct.toFixed(2)}%`;
  const cur = currentZoneInfo();
  const arrow = tgt.octave > cur.octave ? "↑" : tgt.octave < cur.octave ? "↓" : "·";
  if (dom.octLine) {
    dom.octLine.innerHTML = `oct ${cur.octave} &nbsp;→&nbsp; <span class="tgt">${tgt.note} ${arrow} (γ ${tgt.gamma}°)</span>`;
  }
}

function renderStripCells() {
  if (!dom.stripCells) return;
  const scale = SCALES[state.scale];
  const cur = dom.stripCells.dataset.scale || "";
  const key = scale.join(",");
  if (cur === key) return;
  dom.stripCells.innerHTML = "";
  for (const pc of scale) {
    const cell = document.createElement("div");
    cell.className = "scell";
    cell.textContent = pc;
    dom.stripCells.appendChild(cell);
  }
  dom.stripCells.dataset.scale = key;
}

// ── Clear convention ────────────────────────────────────────────────
//   γ (left/right tilt, ±60°) → picks ONE pitch class from the scale
//   β (forward/back tilt)     → picks OCTAVE: back=−1, flat=0, forward=+1
// So e.g. for A minor pentatonic (5 notes), each γ zone is 24° wide.
// For chromatic (12 notes), each zone is 10° wide.
const GAMMA_RANGE = 60;                // ±60 degrees = full scale
const BETA_UP = 25;                    // β > 25° → octave up
const BETA_DOWN = -25;                 // β < -25° → octave down
const BASE_OCTAVE = 4;                 // middle of the range

function currentZoneInfo() {
  const scale = SCALES[state.scale];
  const n = scale.length;
  const g = Math.max(-GAMMA_RANGE, Math.min(GAMMA_RANGE, state.orient.gamma));
  const idx = Math.max(0, Math.min(n - 1, Math.floor(((g + GAMMA_RANGE) / (2 * GAMMA_RANGE)) * n)));
  const b = state.orient.beta;
  const octShift = b > BETA_UP ? 1 : b < BETA_DOWN ? -1 : 0;
  const pitch = scale[idx];
  const octave = BASE_OCTAVE + octShift;
  return { idx, pitch, octave, note: `${pitch}${octave}` };
}
function currentZoneNote() { return currentZoneInfo().note; }

// Push the preview note + zone index + scale layout to the phone so it
// can show a scale strip with the current note highlighted. Also push
// the songbook target so the phone can light the next note green.
let previewKey = "";
function pushPreview() {
  if (!state.paired || !ws || ws.readyState !== WebSocket.OPEN) return;
  const z = currentZoneInfo();
  const tgt = songCurrentTarget?.();
  const key = `${z.note}|${z.idx}|${state.scale}|${tgt?.idx ?? -1}|${tgt?.octave ?? 0}`;
  if (key === previewKey) return;
  previewKey = key;
  try {
    ws.send(JSON.stringify({
      type: "note",
      note: z.note,
      idx: z.idx,
      octave: z.octave,
      scale: SCALES[state.scale],
      scaleName: state.scale,
      target: tgt ? { idx: tgt.idx, octave: tgt.octave, note: tgt.note, gamma: tgt.gamma } : null,
    }));
  } catch {}
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
    if (heldNote && !activeInst.mono) activeInst.triggerRelease?.(heldNote);
    activeInst.triggerAttack(note, undefined, velocity(state.orient.beta));
    heldNote = note;
    state.holding = true;
    state.lastNote = note;
    dom.note.textContent = note;
    renderDebug();
  } catch (e) { console.error("trigger failed", e); }
  // Fade the drone in on first tap and keep it alive while we're playing.
  if (drone) {
    drone.setRoot(SCALE_ROOT[state.scale] || "A");
    drone.fadeIn();
    if (droneTimeout) { clearTimeout(droneTimeout); droneTimeout = null; }
  }
  // Advance the songbook if they hit the target note.
  songAdvanceIfMatched();
}
function holdEnd() {
  state.holding = false;
  if (heldNote && activeInst) { try { activeInst.triggerRelease(heldNote); } catch {} }
  heldNote = null;
  // Linger the drone briefly; fade it out if nobody comes back.
  if (drone) {
    if (droneTimeout) clearTimeout(droneTimeout);
    droneTimeout = setTimeout(() => { drone.fadeOut(); }, 4000);
  }
}
// On mono instruments this is a true continuous glide. On samplers we
// retrigger when the zone actually changes.
function slideToCurrentZone() {
  if (!activeInst || !state.holding) return;
  const note = currentZoneNote();
  if (activeInst.mono) {
    // Continuous portamento — slide.
    try { activeInst.slide?.(note); } catch {}
    if (note !== heldNote) {
      heldNote = note;
      state.lastNote = note;
      dom.note.textContent = note;
      renderDebug();
    }
    return;
  }
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
