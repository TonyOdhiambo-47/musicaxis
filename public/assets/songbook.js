// MusicAxis — songbook
// Each song is a sequence of [scale-index, octave-shift, beats] triples.
// The scale-index is into the song's declared scale (pitch classes, no octave).
// The guide mode highlights the NEXT step on the phone's scale strip, and
// the step advances when the performer's γ zone + octave matches.

export const SONGBOOK = {
  // ─── Public-domain classics ───────────────────────────────────────

  twinkle: {
    name: "Twinkle Twinkle",
    tag: "nursery · C major",
    scale: "major",
    bpm: 80,
    // C C G G A A G | F F E E D D C
    // scale: C D E F G A B  →  indices 0 1 2 3 4 5 6
    steps: [
      [0,0,1],[0,0,1],[4,0,1],[4,0,1],[5,0,1],[5,0,1],[4,0,2],
      [3,0,1],[3,0,1],[2,0,1],[2,0,1],[1,0,1],[1,0,1],[0,0,2],
    ],
  },

  ode_to_joy: {
    name: "Ode to Joy",
    tag: "Beethoven · C major",
    scale: "major",
    bpm: 96,
    // E E F G G F E D C C D E E D D
    steps: [
      [2,0,1],[2,0,1],[3,0,1],[4,0,1],[4,0,1],[3,0,1],[2,0,1],[1,0,1],
      [0,0,1],[0,0,1],[1,0,1],[2,0,1],[2,0,1.5],[1,0,.5],[1,0,2],
    ],
  },

  frere_jacques: {
    name: "Frère Jacques",
    tag: "round · C major",
    scale: "major",
    bpm: 100,
    // C D E C | C D E C | E F G | E F G
    steps: [
      [0,0,1],[1,0,1],[2,0,1],[0,0,1],
      [0,0,1],[1,0,1],[2,0,1],[0,0,1],
      [2,0,1],[3,0,1],[4,0,2],
      [2,0,1],[3,0,1],[4,0,2],
    ],
  },

  saints: {
    name: "When the Saints",
    tag: "new orleans · C major",
    scale: "major",
    bpm: 110,
    // C E F G | C E F G | C E F G E C E D
    steps: [
      [0,0,1],[2,0,1],[3,0,1],[4,0,2],
      [0,0,1],[2,0,1],[3,0,1],[4,0,2],
      [0,0,1],[2,0,1],[3,0,1],[4,0,1],
      [2,0,1],[0,0,1],[2,0,1],[1,0,2],
    ],
  },

  amazing_grace: {
    name: "Amazing Grace",
    tag: "traditional · C major pent",
    scale: "major_pentatonic",
    bpm: 70,
    // Amazing grace how sweet the sound, in C major pent (C D E G A)
    // indices 0 1 2 3 4
    steps: [
      [0,0,1.5],[2,0,.5],[4,0,2],[2,0,1],[0,0,1.5],[4,-1,.5],
      [0,0,3],[2,0,1],[4,0,2],[3,0,1],[2,0,3],
    ],
  },

  greensleeves: {
    name: "Greensleeves",
    tag: "elizabethan · A minor pent",
    scale: "minor_pentatonic",
    bpm: 90,
    // Greensleeves opening — in A minor pent (A C D E G)  idx 0 1 2 3 4
    steps: [
      [0,0,1],[2,0,2],[3,0,1],[4,0,1.5],[3,0,.5],[2,0,1],
      [1,0,2],[1,0,1],[0,0,1.5],[0,0,.5],[0,0,1],
      [0,0,2],[1,0,1],[2,0,1],
    ],
  },

  rising_sun: {
    name: "House of the Rising Sun",
    tag: "trad. folk · A minor pent",
    scale: "minor_pentatonic",
    bpm: 76,
    // Classic am arpeggio feel
    steps: [
      [0,0,1],[2,0,1],[3,0,1],[4,0,2],
      [0,1,1],[4,0,1],[3,0,2],[2,0,1],
      [0,0,1],[2,0,1],[3,0,1],[4,0,2],
      [3,0,1],[2,0,1],[0,0,3],
    ],
  },

  // ─── Original vibe loops (written fresh) ──────────────────────────

  sad_summer: {
    name: "Sad Summer",
    tag: "original · A minor pent · melancholy pop",
    scale: "minor_pentatonic",
    bpm: 92,
    // wandering phrase that lingers on the 4 and 5
    steps: [
      [2,0,1],[3,0,1],[4,0,2],
      [3,0,1],[2,0,1],[1,0,2],
      [0,1,1.5],[4,0,.5],[3,0,2],
      [2,0,1],[0,0,3],
    ],
  },

  lofi_heart: {
    name: "Lofi Heart",
    tag: "original · C major pent · warm late-night",
    scale: "major_pentatonic",
    bpm: 74,
    steps: [
      [0,0,2],[2,0,1],[4,0,1],
      [2,0,2],[1,0,1],[0,0,1],
      [4,-1,2],[0,0,1],[2,0,1],
      [1,0,3],
    ],
  },

  anthem: {
    name: "Anthem",
    tag: "original · C major · hands up",
    scale: "major",
    bpm: 118,
    steps: [
      [0,0,1],[2,0,1],[4,0,1],[2,0,1],
      [3,0,1],[4,0,1],[5,0,2],
      [4,0,1],[2,0,1],[3,0,2],
      [0,0,1],[4,0,1],[6,0,2],
    ],
  },

  campfire: {
    name: "Campfire Waltz",
    tag: "original · C major · 3/4 sway",
    scale: "major",
    bpm: 88,
    steps: [
      [0,0,1],[2,0,1],[4,0,1],
      [2,0,1],[3,0,1],[4,0,2],
      [4,0,1],[5,0,1],[6,0,1],
      [4,0,3],
    ],
  },

  kiss_haze: {
    name: "Kiss Haze",
    tag: "original · A minor pent · woozy dance pop",
    scale: "minor_pentatonic",
    bpm: 102,
    steps: [
      [2,0,.5],[3,0,.5],[2,0,1],[0,0,1],[4,-1,1],
      [0,0,.5],[2,0,.5],[3,0,1],[4,0,2],
      [3,0,1],[2,0,1],[0,0,2],
      [4,-1,1],[2,0,1],[3,0,2],
    ],
  },
};
