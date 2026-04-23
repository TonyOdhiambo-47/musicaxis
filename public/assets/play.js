// MusicAxis controller — tap pad + gyroscope pointer
(function () {
  const $ = (id) => document.getElementById(id);
  const dom = {
    gate: $("gate"), pad: $("pad"), sid: $("sid"), go: $("go"),
    gateHint: $("gate-hint"),
    dot: $("dot"), note: $("note"), ro: $("ro"),
    sdot: $("sdot"), stext: $("stext"),
  };

  const sid = (new URLSearchParams(location.search).get("s") || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!sid) { dom.gateHint.textContent = "no session in URL — scan the QR again"; }
  dom.sid.textContent = sid || "—";

  const state = { alpha: 0, beta: 0, gamma: 0, holding: false, latestNote: "—" };
  const HZ = 30, INT = 1000 / HZ;
  let last = 0, wsReady = false, ws = null;

  dom.go.addEventListener("click", async () => {
    // iOS motion permission (no-op on Android)
    if (typeof DeviceOrientationEvent?.requestPermission === "function") {
      try {
        const r = await DeviceOrientationEvent.requestPermission();
        if (r !== "granted") { setStatus("error", "motion denied"); return; }
      } catch (e) { setStatus("error", e.message); return; }
    }
    if (typeof DeviceMotionEvent?.requestPermission === "function") {
      try { await DeviceMotionEvent.requestPermission(); } catch {}
    }
    dom.gate.hidden = true;
    dom.pad.hidden = false;
    setStatus("idle", "connecting…");
    attachOrient();
    attachPad();
    connectWS();
    try { await navigator.wakeLock?.request?.("screen"); } catch {}
  }, { once: true });

  // ─── WebSocket ─────────────────────────────────────────────────
  function connectWS() {
    if (!sid) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onopen = () => {
      wsReady = true;
      ws.send(JSON.stringify({ type: "join", role: "controller", session: sid }));
      setStatus("live", "connected");
    };
    ws.onclose = () => { wsReady = false; setStatus("error", "disconnected"); setTimeout(connectWS, 1500); };
    ws.onerror = () => {};
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === "presence" && m.status === "paired") setStatus("live", "paired");
        if (m.type === "note") { state.latestNote = m.note; dom.note.textContent = m.note; }
      } catch {}
    };
  }
  function setStatus(s, t) { dom.sdot.dataset.state = s; dom.stext.textContent = t; }
  function send(msg) { if (wsReady && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

  // ─── Orientation: stream + paint dot ───────────────────────────
  function attachOrient() {
    const h = (e) => {
      if (e.alpha == null && e.beta == null && e.gamma == null) return;
      state.alpha = e.alpha || 0;
      state.beta = e.beta || 0;
      state.gamma = e.gamma || 0;
      paint();
      const now = performance.now();
      if (now - last < INT) return;
      last = now;
      send({ type: "orient", alpha: state.alpha, beta: state.beta, gamma: state.gamma });
    };
    window.addEventListener("deviceorientation", h);
    window.addEventListener("deviceorientationabsolute", h);
  }

  function paint() {
    const ringSize = Math.min(280, window.innerWidth * 0.6);
    const r = ringSize * 0.35;
    // gamma → x on ring, beta → y on ring (clamped)
    const x = Math.max(-1, Math.min(1, state.gamma / 60)) * r;
    const y = -Math.max(-1, Math.min(1, state.beta / 60)) * r;
    dom.dot.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    dom.ro.innerHTML = `α <b>${Math.round(state.alpha)}</b> · β <b>${Math.round(state.beta)}</b> · γ <b>${Math.round(state.gamma)}</b>`;
  }

  // ─── Pad: tap anywhere, hold for seamless slide ────────────────
  function attachPad() {
    const down = (ev) => {
      ev.preventDefault();
      if (state.holding) return;
      state.holding = true;
      dom.pad.classList.add("down");
      send({ type: "down", alpha: state.alpha, beta: state.beta, gamma: state.gamma });
      try { navigator.vibrate?.(6); } catch {}
    };
    const up = (ev) => {
      if (!state.holding) return;
      state.holding = false;
      dom.pad.classList.remove("down");
      send({ type: "up" });
    };
    // Any touch / mouse event on the body triggers
    document.body.addEventListener("touchstart", down, { passive: false });
    document.body.addEventListener("touchend", up, { passive: false });
    document.body.addEventListener("touchcancel", up, { passive: false });
    document.body.addEventListener("mousedown", down);
    window.addEventListener("mouseup", up);
    window.addEventListener("blur", up);
  }
})();
