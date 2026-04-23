// MusicAxis — audio engine
// Holds the Tone.js master bus, four instruments, and helpers for
// scale-locked note arrays. Also exposes a MediaStream suitable for
// MediaRecorder so the stage can capture what the audience hears.

const Tone = window.Tone;

// ── Scales ─────────────────────────────────────────────────────────────
// Ordered low → high. Each scale is tuned for the "Despacito intuitive"
// feel: every note is in key, so sweeping gamma across the phone plays
// a melody that sounds right even when it's wrong.
export const SCALES = {
  // A minor pentatonic — fits Dance Monkey, Snowman, countless pop songs
  minor_pentatonic: ["A3", "C4", "D4", "E4", "G4", "A4", "C5", "D5", "E5", "G5"],
  // C major pentatonic — sunshine, nursery-rhyme cheerful
  major_pentatonic: ["C4", "D4", "E4", "G4", "A4", "C5", "D5", "E5", "G5", "A5"],
  // A blues — adds the flat-five for swagger
  blues: ["A3", "C4", "D4", "D#4", "E4", "G4", "A4", "C5", "D5", "E5", "G5"],
  // Full chromatic — fine-tuning, harder to play "pretty"
  chromatic: [
    "A3", "A#3", "B3", "C4", "C#4", "D4", "D#4", "E4", "F4", "F#4",
    "G4", "G#4", "A4", "A#4", "B4", "C5", "C#5", "D5", "D#5", "E5",
  ],
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

  // 2. SYNTH — warm poly
  synth(dest) {
    const synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "triangle" },
      envelope: { attack: 0.05, decay: 0.3, sustain: 0.4, release: 1.2 },
    });
    synth.volume.value = -10;
    synth.connect(dest);
    return {
      triggerAttack: (note, time, vel) => synth.triggerAttack(note, time, vel),
      triggerRelease: (note) => synth.triggerRelease(note),
      dispose: () => synth.disconnect(),
    };
  },

  // 3. STRINGS — saw poly through its own reverb + lowpass
  strings(dest) {
    const reverb = new Tone.Reverb({ decay: 3, wet: 0.45 });
    reverb.generate();
    const filter = new Tone.Filter({ type: "lowpass", frequency: 1200, Q: 0.6 });
    const synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "sawtooth" },
      envelope: { attack: 0.35, decay: 0.25, sustain: 0.8, release: 1.8 },
    });
    synth.volume.value = -14;
    synth.chain(filter, reverb, dest);
    return {
      triggerAttack: (note, time, vel) => synth.triggerAttack(note, time, vel),
      triggerRelease: (note) => synth.triggerRelease(note),
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
      triggerAttack: (note, time, vel) => sampler.triggerAttack(note, time, vel),
      triggerRelease: (note) => sampler.triggerRelease(note, "+0.01"),
      dispose: () => sampler.disconnect(),
    };
  },
};
