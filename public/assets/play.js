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

  dom.btnJoin?.addEventListener("click", () => {
    dom.connect.hidden = true; dom.live.hidden = false; dom.ro.hidden = false;
    setStatus("idle", "connecting…");
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
  function attachOrient() {
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
