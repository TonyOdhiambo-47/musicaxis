(function () {
  const $ = (id) => document.getElementById(id);
  const dom = {
    ios: $("ios"), connect: $("connect"), live: $("live"), err: $("err"),
    sid: $("sid"), ro: $("ro"), ra: $("ra"), rb: $("rb"), rg: $("rg"),
    sdot: $("sdot"), stext: $("stext"), dot: $("dot"),
    btnEnable: $("btn-enable"), btnJoin: $("btn-join"), btnTap: $("btn-tap"),
  };

  const params = new URLSearchParams(location.search);
  const sid = (params.get("s") || params.get("session") || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!sid) { dom.err.hidden = false; setStatus("error", "no session"); return; }
  dom.sid.textContent = sid;

  const needsIOS = typeof DeviceOrientationEvent !== "undefined" &&
    typeof DeviceOrientationEvent.requestPermission === "function";

  if (needsIOS) { dom.ios.hidden = false; setStatus("idle", "grant motion"); }
  else { dom.connect.hidden = false; setStatus("ready", "ready"); }

  dom.btnEnable?.addEventListener("click", async () => {
    try {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== "granted") { setStatus("error", "motion denied"); return; }
      try { await DeviceMotionEvent?.requestPermission?.(); } catch {}
      dom.ios.hidden = true; dom.connect.hidden = false;
      setStatus("ready", "ready");
    } catch (e) { setStatus("error", e.message); }
  }, { once: true });

  dom.btnJoin?.addEventListener("click", async () => {
    dom.connect.hidden = true; dom.live.hidden = false; dom.ro.hidden = false;
    setStatus("idle", "connecting…");
    await primeMotion();
    connectWS();
    attachOrient();
  }, { once: true });

  let ws;
  function connectWS() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onopen = () => { ws.send(JSON.stringify({ type: "join", role: "controller", session: sid })); setStatus("live", "connected"); };
    ws.onclose = () => { setStatus("error", "disconnected"); setTimeout(connectWS, 1500); };
    ws.onerror = () => {};
    ws.onmessage = (e) => { try { const m = JSON.parse(e.data); if (m.type === "presence" && m.status === "paired") setStatus("live", "paired"); } catch {} };
  }

  const HZ = 30, INT = 1000 / HZ;
  let last = 0, latest = { alpha: 0, beta: 0, gamma: 0 };
  let orientAttached = false;
  let sensor = null;
  async function primeMotion() {
    if (typeof DeviceOrientationEvent?.requestPermission === "function") return;
    if (typeof DeviceMotionEvent?.requestPermission === "function") {
      try { await DeviceMotionEvent.requestPermission(); } catch {}
    }
  }
  function attachOrient() {
    if (orientAttached) return;
    orientAttached = true;
    const h = (e) => {
      if (e.alpha == null && e.beta == null && e.gamma == null) return;
      latest.alpha = e.alpha || 0; latest.beta = e.beta || 0; latest.gamma = e.gamma || 0;
      const now = performance.now();
      if (now - last < INT) return;
      last = now;
      send(); paint();
    };
    window.addEventListener("deviceorientation", h);
    window.addEventListener("deviceorientationabsolute", h);
    if ("AbsoluteOrientationSensor" in window) {
      try {
        sensor = new window.AbsoluteOrientationSensor({ frequency: HZ, referenceFrame: "device" });
        sensor.addEventListener("reading", () => {
          if (!sensor.quaternion) return;
          const [x, y, z, w] = sensor.quaternion;
          const ysqr = y * y;
          const t0 = 2 * (w * x + y * z);
          const t1 = 1 - 2 * (x * x + ysqr);
          const roll = Math.atan2(t0, t1);
          let t2 = 2 * (w * y - z * x);
          t2 = Math.max(-1, Math.min(1, t2));
          const pitch = Math.asin(t2);
          const t3 = 2 * (w * z + x * y);
          const t4 = 1 - 2 * (ysqr + z * z);
          const yaw = Math.atan2(t3, t4);
          h({
            alpha: yaw * (180 / Math.PI),
            beta: pitch * (180 / Math.PI),
            gamma: roll * (180 / Math.PI),
          });
        });
        sensor.start();
      } catch {}
    }
  }
  function send() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "orient", alpha: latest.alpha, beta: latest.beta, gamma: latest.gamma }));
  }
  function paint() {
    const x = Math.max(-1, Math.min(1, latest.gamma / 60)) * 40;
    const y = -Math.max(-1, Math.min(1, latest.beta / 60)) * 40;
    dom.dot.style.transform = `translate(${x}px, ${y}px) scale(${1 + Math.abs(latest.beta) / 400})`;
    dom.ra.textContent = Math.round(latest.alpha);
    dom.rb.textContent = Math.round(latest.beta);
    dom.rg.textContent = Math.round(latest.gamma);
  }

  dom.btnTap?.addEventListener("click", () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "tap" }));
    try { navigator.vibrate?.(8); } catch {}
  });

  function setStatus(s, t) { dom.sdot.dataset.state = s; dom.stext.textContent = t; }

  (async () => { try { await navigator.wakeLock?.request?.("screen"); } catch {} })();
})();
