// MusicAxis controller — tap pad + gyroscope pointer
(function () {
  function showFatal(message) {
    const node = document.getElementById("fatal");
    if (!node) return;
    node.hidden = false;
    node.textContent = `play.js error: ${message}`;
  }

  window.addEventListener("error", (event) => {
    showFatal(event.error?.message || event.message || "unknown error");
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason?.message || String(event.reason || "promise rejected");
    showFatal(reason);
  });

  try {
    console.log("[play] loaded", location.href);

    const $ = (id) => document.getElementById(id);
    const dom = {
      gate: $("gate"), pad: $("pad"), sid: $("sid"), go: $("go"),
      gateHint: $("gate-hint"), fatal: $("fatal"),
      note: $("note"), oct: $("oct"), strip: $("strip"), ro: $("ro"),
      sdot: $("sdot"), stext: $("stext"),
    };

    const sid = (new URLSearchParams(location.search).get("s") || "").replace(/[^A-Za-z0-9_-]/g, "");
    if (!sid) { dom.gateHint.textContent = "no session in URL — scan the QR again"; }
    dom.sid.textContent = sid || "—";

    const state = {
      alpha: 0,
      beta: 0,
      gamma: 0,
      holding: false,
      latestNote: "—",
      listenersAttached: false,
      wsConnecting: false,
      recentEvents: [],
    };
    const HZ = 30;
    const INT = 1000 / HZ;
    let last = 0;
    let wsReady = false;
    let ws = null;

    function addEventLine() { /* event log removed — keeping stub in case of legacy calls */ }

    function setStatus(s, t) {
      dom.sdot.dataset.state = s;
      dom.stext.textContent = t;
    }

    function paint() {
      dom.ro.innerHTML = `α <b>${Math.round(state.alpha)}</b> · β <b>${Math.round(state.beta)}</b> · γ <b>${Math.round(state.gamma)}</b>`;
    }

    function renderStrip(scale, activeIdx) {
      if (!dom.strip) return;
      const current = dom.strip.dataset.scale || "";
      const key = scale.join(",");
      if (current !== key) {
        dom.strip.innerHTML = "";
        for (let i = 0; i < scale.length; i++) {
          const cell = document.createElement("div");
          cell.className = "cell";
          cell.textContent = scale[i];
          dom.strip.appendChild(cell);
        }
        dom.strip.dataset.scale = key;
      }
      const cells = dom.strip.children;
      for (let i = 0; i < cells.length; i++) cells[i].classList.toggle("active", i === activeIdx);
    }

    function send(msg) {
      if (wsReady && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    }

    function revealPad() {
      dom.gate.hidden = true;
      dom.pad.hidden = false;
      paint();
    }

    async function requestMotionPermissions() {
      let orientationPermission = "unsupported";
      let motionPermission = "unsupported";
      const OrientationCtor = window.DeviceOrientationEvent;
      const MotionCtor = window.DeviceMotionEvent;

      if (typeof OrientationCtor?.requestPermission === "function") {
        try {
          orientationPermission = await OrientationCtor.requestPermission();
        } catch (error) {
          orientationPermission = `error:${error.message || error}`;
        }
      }

      if (typeof MotionCtor?.requestPermission === "function") {
        try {
          motionPermission = await MotionCtor.requestPermission();
        } catch (error) {
          motionPermission = `error:${error.message || error}`;
        }
      }

      const summary = `perm orient=${orientationPermission} motion=${motionPermission}`;
      addEventLine(summary);
      if (String(orientationPermission).startsWith("error:") || orientationPermission === "denied") {
        setStatus("ready", "motion unavailable");
      }
      return { orientationPermission, motionPermission };
    }

    function connectWS() {
      if (!sid) {
        addEventLine("ws skipped: missing session");
        return;
      }
      if (state.wsConnecting || wsReady) return;

      state.wsConnecting = true;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/ws`);
      ws.onopen = () => {
        console.log("[play] ws open");
        state.wsConnecting = false;
        wsReady = true;
        ws.send(JSON.stringify({ type: "join", role: "controller", session: sid }));
        setStatus("live", "connected");
        addEventLine("ws open");
      };
      ws.onclose = () => {
        wsReady = false;
        state.wsConnecting = false;
        setStatus("error", "disconnected");
        addEventLine("ws closed");
        setTimeout(connectWS, 1500);
      };
      ws.onerror = () => {
        addEventLine("ws error");
      };
      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(e.data);
          if (m.type === "presence" && m.status === "paired") setStatus("live", "paired");
          if (m.type === "note") {
            state.latestNote = m.note;
            dom.note.textContent = m.note;
            if (dom.oct) dom.oct.textContent = `oct ${m.octave ?? ""}`.trim();
            if (Array.isArray(m.scale)) renderStrip(m.scale, m.idx ?? -1);
          }
        } catch {}
      };
    }

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
      addEventLine("orientation listeners attached");
    }

    function attachPad() {
      const down = (ev) => {
        ev.preventDefault();
        if (state.holding) return;
        state.holding = true;
        dom.pad.classList.add("down");
        send({ type: "down", alpha: state.alpha, beta: state.beta, gamma: state.gamma });
        console.log("[play] sent down", state.alpha, state.beta, state.gamma);
        addEventLine(`tap down gamma=${Math.round(state.gamma)}`);
        try { navigator.vibrate?.(6); } catch {}
      };
      const up = () => {
        if (!state.holding) return;
        state.holding = false;
        dom.pad.classList.remove("down");
        send({ type: "up" });
        console.log("[play] sent up");
        addEventLine("tap up");
      };

      document.body.addEventListener("touchstart", down, { passive: false });
      document.body.addEventListener("touchend", up, { passive: false });
      document.body.addEventListener("touchcancel", up, { passive: false });
      document.body.addEventListener("mousedown", down);
      window.addEventListener("mouseup", up);
      window.addEventListener("blur", up);
      addEventLine("pad listeners attached");
    }

    async function startController() {
      console.log("[play] go clicked");
      revealPad();
      setStatus("ready", "starting…");

      if (!state.listenersAttached) {
        attachOrient();
        attachPad();
        state.listenersAttached = true;
      }

      connectWS();
      await requestMotionPermissions();
      try { await navigator.wakeLock?.request?.("screen"); } catch {}
    }

    paint();
    addEventLine("events: waiting for Start");
    dom.go.addEventListener("click", () => {
      startController().catch((error) => {
        showFatal(error?.message || String(error));
        addEventLine(`start failed: ${error?.message || error}`);
      });
    }, { once: true });
  } catch (error) {
    showFatal(error?.message || String(error));
    throw error;
  }
})();
