// MusicAxis — audio engine
// Holds the Tone.js master bus, four instruments, and helpers for
// scale-locked note arrays. Also exposes a MediaStream suitable for
// MediaRecorder so the stage can capture what the audience hears.

const Tone = window.Tone;

// For each scale, the root we drone against (gives every note harmonic context)
export const SCALE_ROOT = {
  minor_pentatonic: "A",
  major_pentatonic: "C",
  major: "C",
  blues: "A",
  chromatic: "A",
};

// ── Scales ─────────────────────────────────────────────────────────────
// Ordered low → high. Each scale is tuned for the "Despacito intuitive"
// feel: every note is in key, so sweeping gamma across the phone plays
// a melody that sounds right even when it's wrong.
// Each scale is a list of PITCH CLASSES (no octave number). The stage adds
// the octave based on β — so γ (left/right tilt) picks the pitch class and
// β (forward tilt) picks the octave. Far fewer, bigger zones; easier to aim.
export const SCALES = {
  // A minor pentatonic — 5 notes (Dance Monkey, Snowman)
  minor_pentatonic: ["A", "C", "D", "E", "G"],
  // C major pentatonic — 5 sunny notes
  major_pentatonic: ["C", "D", "E", "G", "A"],
  // C major — 7 diatonic white keys
  major: ["C", "D", "E", "F", "G", "A", "B"],
  // A blues — 6 notes with the flat five swagger
  blues: ["A", "C", "D", "D#", "E", "G"],
  // Chromatic — every semitone
  chromatic: ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"],
};

// ── Master bus ────────────────────────────────────────────────────────
// Every instrument feeds bus.input. The bus sends to speakers AND to a
// MediaStreamDestination that MediaRecorder captures.
export class MasterBus {
  constructor() {
    // chain: input → eq → compressor → reverb (wet bus) → output
    this.input = new Tone.Gain(1);
    this.filter = new Tone.Filter({ type: "lowpass", frequency: 12000, Q: 0.6 });
    this.compressor = new Tone.Compressor({ threshold: -18, ratio: 3.4, attack: 0.004, release: 0.18 });
    this.reverb = new Tone.Reverb({ decay: 3.2, preDelay: 0.02, wet: 0.2 });
    this.reverbReady = this.reverb.generate(); // returns a promise

    this.output = new Tone.Gain(1);
    this.analyzer = new Tone.Meter({ smoothing: 0.7 });

    this.input.chain(this.filter, this.compressor, this.reverb, this.output);
    this.output.connect(this.analyzer);

    // Fan the output: speakers + a MediaStream tap for MediaRecorder.
    this.output.toDestination();

    const ctx = Tone.getContext().rawContext;
    this.streamDest = ctx.createMediaStreamDestination();
    // Tone nodes expose .output (native AudioNode). Connect the raw node
    // to the MediaStreamDestination so MediaRecorder hears the master mix.
    try {
      const rawOut = this.output.output || this.output._nativeAudioNode || this.output;
      rawOut.connect(this.streamDest);
    } catch (err) {
      // Fallback: connect via Tone.connect (supports cross-context routing)
      Tone.connect(this.output, this.streamDest);
    }
  }

  getStream() { return this.streamDest.stream; }

  getRms() {
    // Tone.Meter returns dBFS. Convert to a 0..1 RMS-ish value.
    const db = this.analyzer.getValue();
    if (typeof db !== "number" || !isFinite(db)) return 0;
    return Math.max(0, Math.min(1, (db + 60) / 60));
  }

  setReverb(wet) {
    this.reverb.wet.rampTo(Math.max(0, Math.min(1, wet)), 0.1);
  }

  setBrightness(t) {
    // t in 0..1; map to filter freq 600 Hz → 14 kHz
    const f = 600 * Math.pow(14000 / 600, Math.max(0, Math.min(1, t)));
    this.filter.frequency.rampTo(f, 0.08);
  }
}

// ── Instruments ───────────────────────────────────────────────────────
export const instrumentFactory = {

  // 1. GRAND PIANO — Tone.Sampler with tonejs-instruments piano samples.
  // If samples don't load in time we transparently fall back to a poly-synth
  // so the instrument always produces sound.
  async piano(onProgress, dest) {
    const base = "https://nbrosowsky.github.io/tonejs-instruments/samples/piano/";
    const urls = { C3: "C3.mp3", C4: "C4.mp3", C5: "C5.mp3", C6: "C6.mp3" };

    // immediate audible fallback — swap it out once the sampler loads
    const fallback = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "triangle" },
      envelope: { attack: 0.005, decay: 0.2, sustain: 0.3, release: 1.0 },
    });
    fallback.volume.value = -8;
    fallback.connect(dest);

    const handle = { loaded: false };
    let sampler = null;

    // progress ticker
    let done = false;
    (async () => {
      const start = Date.now();
      while (!done) {
        onProgress?.(Math.min(0.92, (Date.now() - start) / 1200));
        await new Promise((r) => setTimeout(r, 60));
      }
    })();

    (async () => {
      await new Promise((resolve) => {
        const s = new Tone.Sampler({
          urls, baseUrl: base, release: 1.2,
          onload: () => { sampler = s; handle.loaded = true; resolve(); },
          onerror: () => resolve(),
        });
        s.volume.value = -4;
        s.connect(dest);
        setTimeout(resolve, 6000);
      });
      done = true;
      onProgress?.(1);
    })();

    // Return straight away so startEngine doesn't block on the samples.
    done = true;
    onProgress?.(1);

    return {
      mono: false,
      triggerAttack: (note, time, vel) => {
        if (handle.loaded && sampler) sampler.triggerAttack(note, time, vel);
        else fallback.triggerAttack(note, time, vel);
      },
      triggerRelease: (note) => {
        if (handle.loaded && sampler) sampler.triggerRelease(note, "+0.01");
        else fallback.triggerRelease(note);
      },
      dispose: () => { try { sampler?.disconnect(); } catch {}; try { fallback.disconnect(); } catch {} },
    };
  },

  // 2. SYNTH — mono with PORTAMENTO. Holding + tilting glides pitch smoothly
  // (theremin / ocarina feel). Fat triangle + touch of saw for body.
  synth(dest) {
    const synth = new Tone.MonoSynth({
      portamento: 0.08,
      oscillator: { type: "triangle" },
      envelope: { attack: 0.02, decay: 0.2, sustain: 0.8, release: 0.7 },
      filterEnvelope: { attack: 0.01, decay: 0.15, sustain: 0.6, release: 0.6, baseFrequency: 800, octaves: 2.5 },
    });
    const chorus = new Tone.Chorus({ frequency: 0.8, delayTime: 3, depth: 0.6, wet: 0.4 }).start();
    synth.volume.value = -6;
    synth.chain(chorus, dest);
    return {
      mono: true,
      triggerAttack: (note, time, vel) => synth.triggerAttack(note, time, vel),
      triggerRelease: (note) => synth.triggerRelease(),
      slide: (note) => synth.setNote(note),
      dispose: () => { synth.disconnect(); chorus.disconnect(); },
    };
  },

  // 3. STRINGS — mono saw with deep portamento + reverb → cello/violin feel
  strings(dest) {
    const reverb = new Tone.Reverb({ decay: 4, wet: 0.55 });
    reverb.generate();
    const filter = new Tone.Filter({ type: "lowpass", frequency: 1800, Q: 0.8 });
    const synth = new Tone.MonoSynth({
      portamento: 0.12,
      oscillator: { type: "sawtooth" },
      envelope: { attack: 0.35, decay: 0.3, sustain: 0.85, release: 1.8 },
      filterEnvelope: { attack: 0.35, decay: 0.25, sustain: 0.6, release: 1.5, baseFrequency: 600, octaves: 3 },
    });
    synth.volume.value = -10;
    synth.chain(filter, reverb, dest);
    return {
      mono: true,
      triggerAttack: (note, time, vel) => synth.triggerAttack(note, time, vel),
      triggerRelease: () => synth.triggerRelease(),
      slide: (note) => synth.setNote(note),
      dispose: () => { synth.disconnect(); filter.disconnect(); reverb.disconnect(); },
    };
  },

  // 4. MARIMBA — Tone.Sampler with xylophone CDN samples
  async marimba(dest) {
    const base = "https://nbrosowsky.github.io/tonejs-instruments/samples/xylophone/";
    const sampler = new Tone.Sampler({
      urls: {
        "C3": "C5.mp3",
        "C4": "C6.mp3",
        "C5": "C7.mp3",
        "G3": "G5.mp3",
        "G4": "G6.mp3",
      },
      baseUrl: base,
      release: 2,
    });
    sampler.volume.value = -6;
    sampler.connect(dest);
    await Tone.loaded();
    return {
      mono: false,
      triggerAttack: (note, time, vel) => sampler.triggerAttack(note, time, vel),
      triggerRelease: (note) => sampler.triggerRelease(note, "+0.01"),
      dispose: () => sampler.disconnect(),
    };
  },
};

// ── Drone bed ─────────────────────────────────────────────────────────
// A soft root + fifth pad that plays underneath everything once the
// performer starts playing. Gives every note harmonic context so nothing
// sounds wrong. Fades in on first touch, fades out after silence.
export class DroneBed {
  constructor(dest) {
    this.filter = new Tone.Filter({ type: "lowpass", frequency: 800, Q: 0.4 });
    this.reverb = new Tone.Reverb({ decay: 6, wet: 0.7 });
    this.reverb.generate();
    this.gain = new Tone.Gain(0);
    this.pad = new Tone.PolySynth(Tone.AMSynth, {
      harmonicity: 1.2,
      oscillator: { type: "sine" },
      modulation: { type: "triangle" },
      envelope: { attack: 2, decay: 1, sustain: 0.85, release: 3 },
      modulationEnvelope: { attack: 2.5, decay: 0.5, sustain: 0.8, release: 2 },
    });
    this.pad.volume.value = -14;
    this.pad.chain(this.filter, this.reverb, this.gain, dest);
    this.playing = false;
    this.root = "A";
    this.lastRoot = null;
  }
  setRoot(pitchClass) { this.root = pitchClass; this._restartIfNeeded(); }
  fadeIn() {
    if (this.playing) return;
    this.playing = true;
    const r = `${this.root}2`;
    const f = `${this.root === "C" ? "G" : this.root === "A" ? "E" : "G"}2`;
    this.pad.triggerAttack([r, f]);
    this.lastRoot = this.root;
    this.gain.gain.rampTo(0.7, 2.5);
  }
  fadeOut() {
    if (!this.playing) return;
    this.playing = false;
    this.gain.gain.rampTo(0, 3);
    setTimeout(() => { try { this.pad.releaseAll(); } catch {} }, 3200);
  }
  _restartIfNeeded() {
    if (!this.playing || this.root === this.lastRoot) return;
    try { this.pad.releaseAll(); } catch {}
    const r = `${this.root}2`;
    const f = `${this.root === "C" ? "G" : this.root === "A" ? "E" : "G"}2`;
    this.pad.triggerAttack([r, f]);
    this.lastRoot = this.root;
  }
}
