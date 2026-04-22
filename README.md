# MusicAxis

> Turn a phone into a gyroscope instrument. A desktop browser is the stage,
> the sound engine, and the recorder. The phone is the baton.

Tilt left / right to sweep a scale-locked melody. Tilt forward to play
louder. Rotate for reverb. It's built to feel intuitive — common pop
melodies (Dance Monkey, Snowman, Despacito's hook, a thousand others)
fall out naturally from sweeping your wrist.

Everything runs in the browser; audio never leaves the machine running
the stage. A tiny Node relay forwards orientation from phone to desktop —
that's all it does.

---

## How it works

```
┌──────────────┐                 ┌────────────────────┐                 ┌──────────────────┐
│   phone      │ ─ orient ──▶   │  Node ws relay     │ ─ orient ──▶    │   desktop stage  │
│  /play       │                 │  rooms-by-session   │                 │   /              │
│              │ ◀─ presence ─  │                    │ ◀─ join ──      │   Tone.js engine │
└──────────────┘                 └────────────────────┘                 └──────────────────┘
```

- **Desktop (`/`)** — generates a session id, shows a QR encoding `/play?s=<id>`,
  runs the Tone.js engine and the MediaRecorder.
- **Phone (`/play`)** — scans the QR, grants `DeviceOrientation` (tap-gated on
  iOS), joins the same session over a WebSocket, streams `{alpha, beta, gamma}`
  at 30 Hz.
- **Server (`/ws`)** — keeps a map of sessions to `{stage, controller}` role
  sets and forwards controller messages to stages only. No audio transits;
  rooms expire after 30 minutes of inactivity.

## What you get

Four instruments:
- **Grand Piano** — Salamander samples via [`@tonejs/piano`](https://tonejs.github.io/Piano/)
- **Analog Synth** — warm triangle poly
- **Strings Hall** — sawtooth poly through a lowpass + long reverb
- **Marimba** — sampled xylophone (tonejs-instruments CDN)

Four scales:
- A minor pentatonic (default — the "Dance Monkey / Snowman" pocket)
- C major pentatonic
- A blues
- Chromatic (freeform; harder to play)

Orientation mapping:
- **γ (gamma, left/right)** → pitch, discretized to the current scale with a
  ~2.5° hysteresis band so notes don't jitter at zone boundaries
- **β (beta, forward/back)** → velocity (0.35 → 1.0)
- **α (alpha, rotation)** → reverb wet on a send bus
- **β ⁺ bonus** → master filter brightness (push phone forward to open up)

Every note auto-releases after 800 ms or when γ moves to a new zone.

## Run it locally

You need Node ≥ 18.

```bash
npm install
npm start
# then open http://localhost:3000
```

The server prints a LAN-friendly hint — scan the QR shown on the stage
with your phone to open `/play` in the right session.

### iOS needs HTTPS (important)

iOS won't deliver `DeviceOrientation` events on an insecure origin, and
it won't even *ask for permission* unless you're on HTTPS (or `localhost`
on the same machine, which doesn't help for your phone).

For local testing with your phone on the same LAN:

```bash
./scripts/make-certs.sh        # writes certs/key.pem, certs/cert.pem
HTTPS=1 npm start              # serves on https://<your-lan-ip>:3000
```

Your phone will complain about the self-signed cert. On iOS Settings →
General → About → Certificate Trust Settings, enable the cert you just
imported via Safari. (Or, easier path: deploy to a real host — see below.)

### Ports and env

| env      | default | what it does                                 |
|----------|--------:|----------------------------------------------|
| `PORT`   | 3000    | HTTP(S) port                                 |
| `HTTPS`  | unset   | set to `1` to serve TLS using `certs/*.pem`  |

## Deploy

Anything that can run Node and proxy both HTTP and WebSocket traffic works.
The app is a single `node server/index.js` process that serves the static
front-ends and relays WebSocket frames on `/ws`.

### Railway / Render / Fly / a Linux box

- No build step; just `npm install && npm start`.
- Make sure the host terminates TLS (HTTPS is required for iOS motion perms).
- The WebSocket path is `/ws` — most platforms pass it through automatically.

### Vercel

Vercel Functions can host both the static assets and a lightweight WebSocket
relay via Fluid Compute, but a long-lived `ws` server feels more at home on a
platform that doesn't prefer short-running invocations. A clean split:

- Static `public/` → Vercel (framework preset: "Other", publish `public`).
- `server/index.js` → a small Railway / Fly / Render service on HTTPS.

Point the stage at that relay by editing `public/assets/stage.js` and
`public/assets/play.js` — replace `` `${proto}//${location.host}/ws` `` with
the full `wss://<your-relay>/ws` URL.

## Project layout

```
musicaxis/
  server/
    index.js           # express static + ws relay
  public/
    index.html         # the stage
    play/
      index.html       # the controller
    assets/
      stage.css        # stage styles
      stage.js         # stage app + WebSocket + recorder
      engine.js        # Tone.js master bus + four instruments
      play.css         # controller styles
      play.js          # controller app + WebSocket + orientation
  scripts/
    make-certs.sh      # self-signed certs for local HTTPS
```

## Playing familiar songs

Hold the phone like a conductor's baton — long axis horizontal, screen up.
Keep β (forward-back) near neutral for medium volume; push forward on the
beats that *hit*.

A rough γ map for the default A-minor-pentatonic scale:
```
      ←  phone tilts left              phone tilts right  →
γ: -60     -42    -24    -6     12     30     48     66     84
      A3    C4    D4    E4     G4     A4     C5     D5     E5
```

### Dance Monkey (Tones and I) — intro hook
The call-and-response is just **E4 → G4 → A4 → G4 → E4 → D4**. Sweep γ
from mid-left to center and back for the hook, pushing forward on beats.

### Snowman (Sia) — chorus lift
Lives in A minor: **A3 → C4 → D4 → E4 → G4**, held longer on E/G. Slow
γ sweeps, β pushed forward on the "snowman" downbeats.

### Despacito — hook
B minor in the original, but it maps beautifully onto A minor pentatonic
— sweep **A3 → C4 → E4 → G4** with a triplet feel, then drop back down.

The scale lock means every note lands in key, so "wrong" wrist motions
still sound right. Switch to **Chromatic** when you want to find the
exact melody; switch back to a pentatonic when you want to feel brave.

## Architecture notes

- **Gestures**: `Tone.start()` and `DeviceOrientation.requestPermission()`
  both require user gestures. The stage gates the engine behind
  "Enter the hall"; the phone gates motion behind "Grant motion".
- **Recording**: the master bus uses
  `AudioContext.createMediaStreamDestination()` in addition to the speakers.
  `MediaRecorder` on that stream captures whatever the stage is playing,
  in `audio/webm;codecs=opus` when available, falling back to `ogg` / `mp4`.
- **Hysteresis**: raw γ → zone mapping jitters around boundaries; we require
  γ to move past a boundary by ~2.5° before switching zones.
- **No audio ever hits the network** — the relay only forwards tiny JSON
  orientation frames (~90 B each at 30 Hz).

## Credits + license

- [Tone.js](https://tonejs.github.io/) — Yotam Mann et al.
- [@tonejs/piano](https://tonejs.github.io/Piano/) — Salamander Grand Piano samples
- [tonejs-instruments](https://github.com/nbrosowsky/tonejs-instruments) — the
  xylophone/marimba sample pack
- [qrcode.js](https://github.com/soldair/node-qrcode) — QR generation on the
  stage

MIT. See `LICENSE`.

---

*MusicAxis takes the same pattern as [ChemAxis](https://github.com/TonyOdhiambo-47/chemaxis)
— a phone as a gyroscope companion — and points it at sound. The ritual
doesn't change: pick up a phone, tilt it, the world responds.*
