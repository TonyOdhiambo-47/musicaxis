// musicaxis controller — tap pad + gyroscope pointer
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
      tiltFill: $("tilt-fill"),
      note: $("note"), oct: $("oct"), strip: $("strip"), ro: $("ro"),
      sdot: $("sdot"), stext: $("stext"),
    };

    const sid = (new URLSearchParams(location.search).get("s") || "").replace(/[^A-Za-z0-9_-]/g, "");
    if (!sid) { dom.gateHint.textContent = "no session in URL — scan the QR again"; }
    dom.sid.textContent = sid || "—";

    const state = {
      alpha: null,
      beta: null,
      gamma: null,
      holding: false,
      latestNote: "—",
      listenersAttached: false,
      wsConnecting: false,
      recentEvents: [],
      alpha0: null,
      gamma0: null,
      beta0: null,
      rotRange: 55,      // ±55° of tilt-delta → full scale width
      axis: "gamma",     // which axis is "tilt L/R" — flips with screen orientation
      orientSource: null,
      needsBaselineCapture: true,
    };
    const HZ = 30;
    const INT = 1000 / HZ;
    let last = 0;
    let lastVisual = 0;
    let wsReady = false;
    let ws = null;

    function isFiniteNumber(value) {
      return typeof value === "number" && Number.isFinite(value);
    }

    function readAngle() {
      return (screen.orientation?.angle ?? window.orientation ?? 0) | 0;
    }

    function captureBaseline() {
      if (isFiniteNumber(state.gamma)) state.gamma0 = state.gamma;
      if (isFiniteNumber(state.beta)) state.beta0 = state.beta;
      if (isFiniteNumber(state.alpha)) state.alpha0 = state.alpha;
      state.needsBaselineCapture = false;
    }

    function addEventLine() { /* event log removed — keeping stub in case of legacy calls */ }

    function setStatus(s, t) {
      dom.sdot.dataset.state = s;
      dom.stext.textContent = t;
    }

    function paint() {
      const show = (value) => (isFiniteNumber(value) ? Math.round(value) : "—");
      dom.ro.innerHTML = `α <b>${show(state.alpha)}</b> · β <b>${show(state.beta)}</b> · γ <b>${show(state.gamma)}</b>`;
    }

    function renderStrip(scale, activeIdx, targetIdx) {
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
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        cell.classList.toggle("active", i === activeIdx);
        cell.classList.toggle("target", i === targetIdx && targetIdx !== activeIdx);
        cell.classList.toggle("hit", i === targetIdx && i === activeIdx);
      }
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
            if (dom.oct) {
              let txt = `oct ${m.octave ?? ""}`.trim();
              if (m.target) {
                const tgtOct = m.target.octave;
                const arrow = tgtOct > m.octave ? "↑" : tgtOct < m.octave ? "↓" : "·";
                txt += `  →  ${m.target.note} ${arrow}`;
                if (typeof m.target.gamma === "number") txt += `  (γ ${m.target.gamma}°)`;
              }
              dom.oct.textContent = txt;
            }
            if (Array.isArray(m.scale)) renderStrip(m.scale, m.idx ?? -1, m.target?.idx ?? -1);
          }
        } catch {}
      };
    }

    function pickAxis() {
      // On Android/iOS deviceorientation is in the device frame — it does NOT
      // re-map when the user rotates the screen. So in landscape, "tilt the
      // short ends up/down" is β (pitch), not γ (roll).
      const angle = readAngle();
      if (angle === 90 || angle === 270) state.axis = "beta";
      else state.axis = "gamma";
    }
    function calibrate() {
      pickAxis();
      if (isFiniteNumber(state.beta) || isFiniteNumber(state.gamma) || isFiniteNumber(state.alpha)) {
        captureBaseline();
        dom.note.textContent = `center set · tilt=${state.axis}`;
      } else {
        state.needsBaselineCapture = true;
        dom.note.textContent = `waiting for motion · tilt=${state.axis}`;
      }
      setTimeout(() => { dom.note.textContent = state.latestNote; }, 900);
    }
    // Racing-game tilt: whichever axis lives along the user's "left/right"
    // given the current screen orientation, with a calibrated centre.
    function effectiveGamma() {
      const angle = readAngle();
      let raw, base, sign = 1;
      if (angle === 90) { raw = state.beta;  base = state.beta0  ?? 0; sign = -1; } // top on right
      else if (angle === 270) { raw = state.beta; base = state.beta0 ?? 0; sign = 1; } // top on left
      else { raw = state.gamma; base = state.gamma0 ?? 0; sign = 1; } // portrait
      if (!isFiniteNumber(raw)) return 0;
      if (base == null || isNaN(base)) base = raw;
      const delta = sign * (raw - base);
      return Math.max(-state.rotRange, Math.min(state.rotRange, delta));
    }

    function paintTiltBar() {
      if (!dom.tiltFill) return;
      const clamped = effectiveGamma();
      const half = 50;
      const width = Math.abs(clamped) / state.rotRange * half;
      dom.tiltFill.style.left = `${clamped < 0 ? half - width : half}%`;
      dom.tiltFill.style.width = `${width}%`;
      dom.tiltFill.dataset.side = clamped < 0 ? "left" : clamped > 0 ? "right" : "center";
    }

    function animateVisuals(now) {
      if (!lastVisual || now - lastVisual >= INT) {
        lastVisual = now;
        paintTiltBar();
      }
      requestAnimationFrame(animateVisuals);
    }

    function attachOrient() {
      const h = (e) => {
        const source = e.type === "deviceorientationabsolute" ? "absolute" : "relative";
        if (source === "relative" && state.orientSource === "absolute") return;
        if (source === "absolute" && state.orientSource !== "absolute") {
          state.orientSource = "absolute";
          state.needsBaselineCapture = true;
        } else if (!state.orientSource) {
          state.orientSource = source;
        }

        const hasAlpha = isFiniteNumber(e.alpha);
        const hasBeta = isFiniteNumber(e.beta);
        const hasGamma = isFiniteNumber(e.gamma);
        if (!hasAlpha && !hasBeta && !hasGamma) return;

        if (hasAlpha) state.alpha = e.alpha;
        if (hasBeta) state.beta = e.beta;
        if (hasGamma) state.gamma = e.gamma;
        if (state.needsBaselineCapture && (isFiniteNumber(state.beta) || isFiniteNumber(state.gamma) || isFiniteNumber(state.alpha))) {
          captureBaseline();
        }
        paint();
        const now = performance.now();
        if (now - last < INT) return;
        last = now;
        // Send the orientation-aware effective tilt as "gamma" — stage logic is unchanged.
        send({ type: "orient", alpha: state.alpha, beta: state.beta, gamma: effectiveGamma(), axis: state.axis });
      };
      window.addEventListener("deviceorientation", h);
      window.addEventListener("deviceorientationabsolute", h);
      document.getElementById("recenter")?.addEventListener("click", calibrate);
      // Re-pick the axis immediately, then re-capture baselines on the first
      // post-rotate sensor sample so we do not freeze in stale pre-rotate data.
      const onRotate = () => {
        pickAxis();
        state.needsBaselineCapture = true;
      };
      screen.orientation?.addEventListener?.("change", onRotate);
      window.addEventListener("orientationchange", onRotate);
      pickAxis();
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
    paintTiltBar();
    requestAnimationFrame(animateVisuals);
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
