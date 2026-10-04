// ─────────────────────────────────────────────────────────────────────────────
// Procedural soundtrack for the demo project ("pooBeat"): 120 BPM, A minor,
// six bars (12 s). Rendered offline with the Web Audio API and encoded as a
// 16-bit PCM WAV so it behaves exactly like imported footage — waveform in the
// timeline, Audio Spectrum input, scrubbing, and muxed into exported video.
//
//   bar 0      pad + noise riser                  (camera push-in, logo build)
//   bar 1–5    impact on 2.0 s, four-on-the-floor kick with side-chained pad,
//              off-beat bass, claps, hats, delayed arpeggio
//   last 0.6 s master fade so the RAM preview loops cleanly
// ─────────────────────────────────────────────────────────────────────────────

export const DEMO_MUSIC_KEY = 'demo-music-v1';
export const DEMO_MUSIC_DURATION = 12;
const BPM = 120;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const SAMPLE_RATE = 48000;

const midi = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** Chord per bar (MIDI notes): Am – F – C – G – Am – F. */
const CHORDS: number[][] = [
  [57, 60, 64],
  [53, 57, 60],
  [55, 60, 64],
  [55, 59, 62],
  [57, 60, 64],
  [53, 57, 60],
];
const ROOTS = [45, 41, 48, 43, 45, 41];

function noiseBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
  const d = buf.getChannelData(0);
  // deterministic noise so every generated copy is bit-identical
  let s = 0x2f6b9a1d;
  for (let i = 0; i < d.length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    d[i] = ((s >>> 0) / 0xffffffff) * 2 - 1;
  }
  return buf;
}

/** Synthetic stereo hall impulse response for the shared reverb. */
function impulse(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const len = Math.ceil(seconds * ctx.sampleRate);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let s = c ? 0x51ed27b3 : 0x1b873593;
    for (let i = 0; i < len; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      const n = ((s >>> 0) / 0xffffffff) * 2 - 1;
      d[i] = n * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

export async function renderDemoMusic(): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, SAMPLE_RATE * DEMO_MUSIC_DURATION, SAMPLE_RATE);
  const noise = noiseBuffer(ctx, 2);

  // ── master chain ──
  const master = ctx.createGain();
  master.gain.setValueAtTime(0, 0);
  master.gain.linearRampToValueAtTime(0.9, 0.08);
  master.gain.setValueAtTime(0.9, DEMO_MUSIC_DURATION - 0.6);
  master.gain.linearRampToValueAtTime(0, DEMO_MUSIC_DURATION - 0.02);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.knee.value = 8;
  comp.ratio.value = 4;
  comp.attack.value = 0.004;
  comp.release.value = 0.22;
  master.connect(comp).connect(ctx.destination);

  const reverb = ctx.createConvolver();
  reverb.buffer = impulse(ctx, 2.6, 3.2);
  const reverbReturn = ctx.createGain();
  reverbReturn.gain.value = 0.32;
  reverb.connect(reverbReturn).connect(master);

  const delay = ctx.createDelay(1);
  delay.delayTime.value = BEAT * 0.75;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.38;
  const delayTone = ctx.createBiquadFilter();
  delayTone.type = 'lowpass';
  delayTone.frequency.value = 3200;
  delay.connect(delayTone).connect(feedback).connect(delay);
  const delayReturn = ctx.createGain();
  delayReturn.gain.value = 0.42;
  delayTone.connect(delayReturn).connect(master);

  // ── pad (side-chained to the kick from bar 1) ──
  const padBus = ctx.createGain();
  padBus.gain.value = 1;
  const padFilter = ctx.createBiquadFilter();
  padFilter.type = 'lowpass';
  padFilter.Q.value = 0.8;
  padFilter.frequency.setValueAtTime(520, 0);
  padFilter.frequency.exponentialRampToValueAtTime(1900, BAR);
  padFilter.frequency.setValueAtTime(1400, BAR);
  padFilter.frequency.exponentialRampToValueAtTime(3200, DEMO_MUSIC_DURATION - 1);
  padBus.connect(padFilter);
  padFilter.connect(master);
  const padSend = ctx.createGain();
  padSend.gain.value = 0.55;
  padFilter.connect(padSend).connect(reverb);
  CHORDS.forEach((chord, bar) => {
    const t0 = bar * BAR;
    const t1 = t0 + BAR;
    chord.forEach((note, vi) => {
      for (const detune of [-8, 7]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = midi(note);
        o.detune.value = detune;
        const g = ctx.createGain();
        const pan = ctx.createStereoPanner();
        pan.pan.value = (vi - 1) * 0.45 + (detune < 0 ? -0.15 : 0.15);
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(0.034, t0 + (bar === 0 ? 1.2 : 0.18));
        g.gain.setValueAtTime(0.034, t1 - 0.05);
        g.gain.linearRampToValueAtTime(0, t1 + 0.35);
        o.connect(g).connect(pan).connect(padBus);
        o.start(t0);
        o.stop(t1 + 0.4);
      }
    });
  });
  for (let t = BAR; t < DEMO_MUSIC_DURATION - 1e-6; t += BEAT) {
    padBus.gain.setValueAtTime(0.28, t);
    padBus.gain.linearRampToValueAtTime(1, t + BEAT * 0.8);
  }

  // ── riser into the impact ──
  {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 2.4;
    bp.frequency.setValueAtTime(300, 0.2);
    bp.frequency.exponentialRampToValueAtTime(7000, BAR - 0.02);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, 0.2);
    g.gain.exponentialRampToValueAtTime(0.32, BAR - 0.04);
    g.gain.linearRampToValueAtTime(0, BAR);
    const pan = ctx.createStereoPanner();
    pan.pan.setValueAtTime(-0.6, 0.2);
    pan.pan.linearRampToValueAtTime(0.6, BAR);
    src.connect(bp).connect(g).connect(pan).connect(master);
    g.connect(reverb);
    src.start(0.2);
    src.stop(BAR + 0.05);
  }

  // ── impact (sub boom + noise crash) at the first downbeat ──
  {
    const t = BAR;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 1.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.95, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.6);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 1.7);
    const n = ctx.createBufferSource();
    n.buffer = noise;
    n.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(9000, t);
    lp.frequency.exponentialRampToValueAtTime(600, t + 1.8);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.4, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 2);
    n.connect(lp).connect(ng).connect(master);
    ng.connect(reverb);
    n.start(t);
    n.stop(t + 2.1);
  }

  // ── drums ──
  const drumEnd = DEMO_MUSIC_DURATION - 0.3;
  for (let t = BAR; t < drumEnd; t += BEAT) {
    // kick
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(46, t + 0.11);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.85, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.45);
  }
  for (let t = BAR * 2; t < drumEnd; t += BEAT) {
    const beatInBar = Math.round((t % BAR) / BEAT);
    // clap on 2 and 4
    if (beatInBar === 1 || beatInBar === 3) {
      for (const [dt, amp] of [[0, 0.32], [0.011, 0.24], [0.023, 0.3]] as const) {
        const n = ctx.createBufferSource();
        n.buffer = noise;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1450;
        bp.Q.value = 1.1;
        const g = ctx.createGain();
        g.gain.setValueAtTime(amp, t + dt);
        g.gain.exponentialRampToValueAtTime(0.001, t + dt + 0.19);
        n.connect(bp).connect(g).connect(master);
        g.connect(reverb);
        n.start(t + dt, (t * 0.61 + dt * 17) % 1.5);
        n.stop(t + dt + 0.2);
      }
    }
    // hats: open on the off-beat, closed ghost 16ths
    for (const [off, amp, len] of [[BEAT / 2, 0.11, 0.09], [BEAT / 4, 0.035, 0.03], [(BEAT * 3) / 4, 0.045, 0.03]] as const) {
      const at = t + off;
      if (at >= drumEnd) continue;
      const n = ctx.createBufferSource();
      n.buffer = noise;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 7600;
      const g = ctx.createGain();
      g.gain.setValueAtTime(amp, at);
      g.gain.exponentialRampToValueAtTime(0.001, at + len);
      const pan = ctx.createStereoPanner();
      pan.pan.value = off === BEAT / 2 ? 0.2 : -0.25;
      n.connect(hp).connect(g).connect(pan).connect(master);
      n.start(at, (at * 0.37) % 1.5);
      n.stop(at + len + 0.01);
    }
  }

  // ── off-beat bass ──
  for (let bar = 1; bar < CHORDS.length; bar++) {
    for (let b = 0; b < 4; b++) {
      const t = bar * BAR + b * BEAT + BEAT / 2;
      if (t >= drumEnd) continue;
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = midi(ROOTS[bar]);
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.value = midi(ROOTS[bar] - 12);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 6;
      lp.frequency.setValueAtTime(1400, t);
      lp.frequency.exponentialRampToValueAtTime(180, t + 0.2);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.2, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
      o.connect(lp).connect(g).connect(master);
      sub.connect(g);
      o.start(t);
      sub.start(t);
      o.stop(t + 0.26);
      sub.stop(t + 0.26);
    }
  }

  // ── sixteenth-note arpeggio through the dotted-eighth delay ──
  for (let bar = 1; bar < CHORDS.length; bar++) {
    const notes = [...CHORDS[bar], CHORDS[bar][0] + 12].map((n) => n + 12);
    for (let s = 0; s < 16; s++) {
      const t = bar * BAR + s * (BEAT / 4);
      if (t >= drumEnd) continue;
      const pattern = [0, 1, 2, 3, 2, 1, 3, 2];
      const note = notes[pattern[s % pattern.length]];
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = midi(note);
      const o2 = ctx.createOscillator();
      o2.type = 'square';
      o2.frequency.value = midi(note) * 2.001;
      const g2 = ctx.createGain();
      g2.gain.value = 0.18;
      const g = ctx.createGain();
      const accent = s % 4 === 0 ? 1 : 0.7;
      const level = 0.05 * accent * Math.min(1, 0.45 + (bar - 1) * 0.2);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(level, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0008, t + 0.17);
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.sin(s * 1.7) * 0.5;
      o.connect(g);
      o2.connect(g2).connect(g);
      g.connect(pan).connect(master);
      pan.connect(delay);
      o.start(t);
      o2.start(t);
      o.stop(t + 0.19);
      o2.stop(t + 0.19);
    }
  }

  return ctx.startRendering();
}

/** Encode an AudioBuffer as 16-bit PCM WAV. */
export function encodeWav(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const bytes = 44 + frames * channels * 2;
  const view = new DataView(new ArrayBuffer(bytes));
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  view.setUint32(4, bytes - 8, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, frames * channels * 2, true);
  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([view.buffer], { type: 'audio/wav' });
}

export async function generateDemoMusic(): Promise<Blob> {
  return encodeWav(await renderDemoMusic());
}
