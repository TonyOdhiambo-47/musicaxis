// MusicAxis — controller (/play)
// Jobs:
//  - read the `s=<session>` query param (from the QR code)
//  - unlock DeviceOrientation on iOS behind a user tap
//  - open a WebSocket to the relay, join as `controller`
//  - stream orientation at ~30fps to the stage
//  - render a tiny visualizer + debug readout

(function () {
  const $ = (id) => document.getElementById(id);
  const dom = {
    body: document.body,
    sessionCode: $("session-code"),
    stageIos: $("stage-ios"),
    stageConnect: $("stage-connect"),
    stageLive: $("stage-live"),
    stageError: $("stage-error"),
    btnEnable: $("btn-enable"),
    btnJoin: $("btn-join"),
    btnTap: $("btn-tap"),
    sDot: $("s-dot"),
    sText: $("s-text"),
    fork: $("p-fork"),
    corona: $("p-corona"),
    halo: $("p-halo"),
    readout: $("readout"),
    rA: $("r-alpha"),
    rB: $("r-beta"),
    rG: $("r-gamma"),
    rZone: $("r-zone"),
  };

  // Entry animation
  requestAnimationFrame(() => dom.body.classList.replace("pre-enter", "entered"));

  // Parse session from URL; accept `s=` or legacy `session=`
  const params = new URLSearchParams(location.search);
  const sid = (params.get("s") || params.get("session") || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!sid) { dom.stageError.hidden = false; setStatus("error", "no session"); return; }
  dom.sessionCode.textContent = sid;

  // Detect iOS permission gate
  const iosNeedsPerm =
    typeof DeviceOrientationEvent !== "undefined" &&
    typeof DeviceOrientationEvent.requestPermission === "function";

  if (iosNeedsPerm) {
    dom.stageIos.hidden = false;
    setStatus("idle", "tap to grant motion");
  } else {
    dom.stageConnect.hidden = false;
    setStatus("ready", "ready · tap connect");
  }

  dom.btnEnable.addEventListener("click", onEnableIOS, { once: true });
  dom.btnJoin.addEventListener("click", onJoin, { once: true });

  async function onEnableIOS() {
    try {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res !== "granted") {
        setStatus("error", "motion denied · enable in Settings → Safari");
        return;
      }
      // iOS also exposes DeviceMotion (needed for some devices)
      if (typeof DeviceMotionEvent !== "undefined" &&
          typeof DeviceMotionEvent.requestPermission === "function") {
        try { await DeviceMotionEvent.requestPermission(); } catch {}
      }
      dom.stageIos.hidden = true;
      dom.stageConnect.hidden = false;
      setStatus("ready", "ready · tap connect");
    } catch (err) {
      setStatus("error", err.message || "permission error");
    }
  }

  let ws;
  function onJoin() {
    dom.stageConnect.hidden = true;
    dom.stageLive.hidden = false;
    dom.readout.hidden = false;
    setStatus("idle", "connecting…");
    connectWS();
    attachOrientation();
  }

  function connectWS() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "join", role: "controller", session: sid }));
      setStatus("live", "connected");
    };
    ws.onclose = () => {
      setStatus("error", "disconnected · retrying…");
      setTimeout(connectWS, 1500);
    };
    ws.onerror = () => {};
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === "presence" && m.status === "paired") setStatus("live", "paired with stage");
      } catch {}
    };
  }

  // ─── Orientation streaming ─────────────────────────────────────────
  const STREAM_HZ = 30;
  const STREAM_INTERVAL = 1000 / STREAM_HZ;
  let last = 0;
  let latest = { alpha: 0, beta: 0, gamma: 0 };

  function attachOrientation() {
    const handler = (e) => {
      if (e.alpha == null && e.beta == null && e.gamma == null) return;
      latest.alpha = e.alpha || 0;
      latest.beta = e.beta || 0;
      latest.gamma = e.gamma || 0;
      const now = performance.now();
      if (now - last < STREAM_INTERVAL) return;
      last = now;
      send();
      paint();
    };
    // iOS 13+ sometimes needs "deviceorientationabsolute" — fall back
    window.addEventListener("deviceorientation", handler);
    window.addEventListener("deviceorientationabsolute", handler);
  }

  function send() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: "orient",
      alpha: latest.alpha, beta: latest.beta, gamma: latest.gamma,
      t: Date.now(),
    }));
  }

  function paint() {
    dom.fork.setAttribute("transform", `translate(150 150) rotate(${(latest.gamma * 0.6).toFixed(2)})`);
    dom.corona.setAttribute("transform", `translate(150 150) rotate(${latest.alpha.toFixed(1)})`);
    const s = 1 + Math.min(1, Math.abs(latest.beta) / 80) * 0.14;
    dom.halo.setAttribute("transform", `translate(150 150) scale(${s.toFixed(3)}) translate(-150 -150)`);
    dom.rA.textContent = latest.alpha.toFixed(0);
    dom.rB.textContent = latest.beta.toFixed(0);
    dom.rG.textContent = latest.gamma.toFixed(0);
    const zone = Math.max(0, Math.min(9, Math.floor(((latest.gamma + 60) / 120) * 10)));
    dom.rZone.textContent = `zone ${zone + 1}/10`;
  }

  dom.btnTap.addEventListener("click", () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "tap", t: Date.now() }));
    try { navigator.vibrate?.(8); } catch {}
  });

  function setStatus(state, text) {
    dom.sDot.dataset.state = state;
    dom.sText.textContent = text;
  }

  // Keep screen awake if browser permits
  (async () => {
    try { await navigator.wakeLock?.request?.("screen"); } catch {}
  })();
})();
