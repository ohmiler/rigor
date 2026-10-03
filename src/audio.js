// Every sound in the game, synthesised with Web Audio: no sample files to load
// or license. Each effect is a few oscillators and filtered noise bursts with
// short envelopes. Sounds in the world are panned and fade with distance from
// the player (the camera looks along +Z, so screen-right is world -X).

const MUTE_KEY = 'rigor.muted';

const rand = (a, b) => a + Math.random() * (b - a);

export class Sound {
  constructor() {
    this.ctx = null;
    this.listener = null; // a Vector3 to measure distances from (the player)
    this.heartTimer = 0;
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      this.muted = false;
    }
  }

  // Browsers only allow audio after the player has clicked or pressed a key,
  // so this runs from the start screen.
  start() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    // A gentle limiter so a gunfight full of screams doesn't clip.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    this.master.connect(comp).connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this._startAmbience();
  }

  toggleMute() {
    this.muted = !this.muted;
    try {
      localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
    } catch {
      // Storage blocked: the setting just won't stick.
    }
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.8, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  // ------------------------------------------------------------ building blocks

  // An output for one sound: volume and stereo pan from where it happens, or
  // null if it's too far away to hear (so nothing gets built for it).
  _out(pos, range, volume) {
    if (!this.ctx || this.muted) return null;
    let gain = volume;
    let pan = 0;
    if (pos && this.listener) {
      const dx = pos.x - this.listener.x;
      const dz = pos.z - this.listener.z;
      const d = Math.hypot(dx, dz);
      const near = Math.max(1 - d / range, 0);
      gain *= near * near;
      pan = Math.max(-1, Math.min(1, -dx / 9));
    }
    if (gain < 0.004) return null;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    if (pan && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p).connect(this.master);
    } else {
      g.connect(this.master);
    }
    return g;
  }

  // A burst of filtered noise.
  _noise(dest, { at = 0, dur = 0.1, type = 'lowpass', freq = 1000, freqEnd, q = 1, gain = 1, attack = 0.002 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = rand(0.9, 1.1);
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
    return g;
  }

  // A pitched blip that can glide.
  _tone(dest, { at = 0, dur = 0.1, type = 'sine', freq = 440, freqEnd, gain = 1, attack = 0.002 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(dest);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  // A rough voice: a buzzing source (sawtooth with a wobble, plus breath)
  // shaped by two formant filters into an "ooh" or an "aah".
  _voice(dest, { dur, f0, f0End, formants, gain, rasp = 0.3, vibrato = 4, attack = 0.08 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f0End, t + dur);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = vibrato + rand(-1, 1);
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = f0 * 0.06;
    lfo.connect(lfoGain).connect(osc.frequency);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + attack);
    env.gain.setValueAtTime(gain, t + dur * 0.6);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    env.connect(dest);

    for (const [freq, q, level] of formants) {
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = freq;
      f.Q.value = q;
      const lv = ctx.createGain();
      lv.gain.value = level;
      osc.connect(f).connect(lv).connect(env);
    }
    if (rasp > 0) {
      const n = ctx.createBufferSource();
      n.buffer = this.noiseBuffer;
      const nf = ctx.createBiquadFilter();
      nf.type = 'bandpass';
      nf.frequency.value = formants[0][0] * 1.5;
      nf.Q.value = 0.8;
      const ng = ctx.createGain();
      ng.gain.value = rasp;
      n.connect(nf).connect(ng).connect(env);
      n.start(t, Math.random());
      n.stop(t + dur + 0.05);
    }
    osc.start(t);
    lfo.start(t);
    osc.stop(t + dur + 0.05);
    lfo.stop(t + dur + 0.05);
  }

  // Wind down an empty street: slow swells of low noise, very quiet.
  _startAmbience() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 380;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.03;
    lfo.connect(lfoGain).connect(g.gain);
    src.connect(f).connect(g).connect(this.master);
    src.start();
    lfo.start();
  }

  // ------------------------------------------------------------ the player's gun

  // `small`: a pistol, a sharper and lighter crack than the rifle.
  gunshot(pos, small = false) {
    const o = this._out(pos, 60, small ? 0.7 : 0.9);
    if (!o) return;
    const p = rand(0.92, 1.08) * (small ? 1.35 : 1);
    this._noise(o, { dur: 0.06, type: 'highpass', freq: 1800 * p, gain: 0.9 }); // crack
    this._noise(o, { dur: 0.22, type: 'lowpass', freq: 1100 * p, freqEnd: 300, gain: 1.1 }); // blast
    this._tone(o, { dur: 0.16, freq: 130 * p, freqEnd: 42, gain: 0.9 }); // thump
    this._noise(o, { at: 0.03, dur: 0.7, type: 'bandpass', freq: 420, q: 0.7, gain: 0.18, attack: 0.04 }); // street echo
  }

  // Putting a gun away / drawing one: a rustle of the sling or holster and a click.
  weapon(event) {
    const o = this._out(null, 0, 0.4);
    if (!o) return;
    if (event === 'holster') {
      this._noise(o, { dur: 0.16, type: 'bandpass', freq: 900, q: 0.8, gain: 0.5, attack: 0.03 });
    } else if (event === 'draw') {
      this._noise(o, { dur: 0.12, type: 'bandpass', freq: 1200, q: 0.8, gain: 0.45, attack: 0.02 });
      this._noise(o, { at: 0.1, dur: 0.04, type: 'bandpass', freq: 2600, q: 5, gain: 0.6 });
    } else if (event === 'slash' || event === 'stab') {
      // A blade cutting the air.
      const f = event === 'slash' ? [900, 2600] : [1400, 3000];
      this._noise(o, { dur: 0.14, type: 'bandpass', freq: f[0], freqEnd: f[1], q: 2, gain: 0.55, attack: 0.02 });
    } else if (event === 'throw') {
      this._noise(o, { at: 0.2, dur: 0.16, type: 'bandpass', freq: 500, freqEnd: 1000, q: 0.8, gain: 0.4, attack: 0.03 });
    } else if (event === 'shove') {
      this._noise(o, { dur: 0.18, type: 'bandpass', freq: 500, freqEnd: 1100, q: 0.8, gain: 0.6, attack: 0.03 }); // whoosh
      this._voice(o, { dur: 0.2, f0: 130, f0End: 115, formants: [[550, 4, 1], [950, 5, 0.5]], gain: 0.35, rasp: 0.4, attack: 0.01 }); // effort
    }
  }

  // A bottle smashing: a sharp crack and a spray of tinkling glass. Loud.
  glass(pos) {
    const o = this._out(pos, 40, 0.8);
    if (!o) return;
    this._noise(o, { dur: 0.05, type: 'highpass', freq: 2500, gain: 1 });
    this._noise(o, { dur: 0.25, type: 'bandpass', freq: 4200, q: 1.5, gain: 0.6 });
    for (let i = 0; i < 7; i++) {
      this._tone(o, { at: 0.03 + Math.random() * 0.35, dur: 0.07, type: 'sine', freq: rand(3000, 6500), gain: 0.18 });
    }
  }

  // The knife going in.
  stab(pos) {
    const o = this._out(pos, 16, 0.6);
    if (!o) return;
    this._noise(o, { dur: 0.06, type: 'lowpass', freq: 700, gain: 0.9 });
    this._noise(o, { at: 0.02, dur: 0.18, type: 'bandpass', freq: 1100, freqEnd: 350, q: 3, gain: 0.7 });
  }

  // The shove landing on a body.
  thump(pos) {
    const o = this._out(pos, 20, 0.6);
    if (!o) return;
    this._noise(o, { dur: 0.1, type: 'lowpass', freq: 450, gain: 1 });
    this._tone(o, { dur: 0.1, freq: 95, freqEnd: 60, gain: 0.6 });
  }

  dryClick() {
    const o = this._out(null, 0, 0.5);
    if (!o) return;
    this._tone(o, { dur: 0.02, type: 'square', freq: 1900, gain: 0.25 });
    this._noise(o, { dur: 0.03, type: 'highpass', freq: 3000, gain: 0.4 });
  }

  reload(step) {
    const o = this._out(null, 0, 0.55);
    if (!o) return;
    if (step === 'eject') {
      this._noise(o, { dur: 0.05, type: 'bandpass', freq: 2600, q: 6, gain: 0.8 });
      this._tone(o, { dur: 0.06, type: 'triangle', freq: 820, freqEnd: 600, gain: 0.3 });
      // The empty mag hitting the ground a moment later.
      this._noise(o, { at: 0.38, dur: 0.06, type: 'bandpass', freq: 1500, q: 3, gain: 0.35 });
    } else if (step === 'take') {
      this._noise(o, { dur: 0.09, type: 'lowpass', freq: 1400, gain: 0.35 });
    } else if (step === 'seat') {
      this._noise(o, { dur: 0.04, type: 'bandpass', freq: 2200, q: 5, gain: 0.9 });
      this._noise(o, { at: 0.07, dur: 0.05, type: 'bandpass', freq: 3200, q: 6, gain: 0.7 });
      this._tone(o, { at: 0.07, dur: 0.05, type: 'square', freq: 1200, gain: 0.12 });
    }
  }

  // ------------------------------------------------------------ bodies

  footstep(pos, { zombie = false, drag = false, speed = 1 } = {}) {
    const loud = zombie ? 0.35 : 0.18 + 0.12 * Math.min(speed / 4, 1);
    const o = this._out(pos, zombie ? 14 : 20, loud);
    if (!o) return;
    if (zombie && drag) {
      // A foot dragged along the asphalt.
      this._noise(o, { dur: 0.28, type: 'bandpass', freq: 650, q: 1.2, gain: 0.6, attack: 0.05 });
      return;
    }
    this._noise(o, { dur: 0.07, type: 'lowpass', freq: rand(700, 1000), gain: 0.8 });
    this._tone(o, { dur: 0.05, freq: rand(70, 95), gain: 0.5 });
    if (zombie) this._noise(o, { at: 0.02, dur: 0.12, type: 'bandpass', freq: 500, q: 1, gain: 0.25 });
  }

  land(pos, impact) {
    const o = this._out(pos, 20, Math.min(0.3 + impact * 0.1, 0.8));
    if (!o) return;
    this._noise(o, { dur: 0.14, type: 'lowpass', freq: 600, gain: 0.9 });
    this._tone(o, { dur: 0.12, freq: 90, freqEnd: 50, gain: 0.7 });
  }

  // Wandering: a low moan. Chasing: louder and rougher. `pitch` sets the
  // voice: a runner's is higher and thinner, a brute's a deep rumble.
  groan(pos, angry = false, pitch = 1) {
    const o = this._out(pos, angry ? 26 : 18, angry ? 0.45 : 0.3);
    if (!o) return;
    const f0 = rand(70, 105) * (angry ? 1.3 : 1) * pitch;
    this._voice(o, {
      dur: rand(0.8, 1.6),
      f0,
      f0End: f0 * rand(0.7, 0.85),
      formants: angry ? [[650, 4, 1], [1100, 5, 0.6]] : [[420, 5, 1], [850, 6, 0.4]],
      gain: 0.9,
      rasp: angry ? 0.6 : 0.25,
      vibrato: rand(3, 6),
    });
  }

  // It has seen you. A screamer's `big` shriek is long, piercing and carries
  // down the whole street.
  scream(pos, pitch = 1, big = false) {
    const o = this._out(pos, big ? 70 : 40, big ? 0.85 : 0.6);
    if (!o) return;
    const f0 = rand(230, 300) * pitch;
    if (big) {
      this._voice(o, { dur: 1.6, f0: f0 * 1.2, f0End: f0 * 0.9, formants: [[1200, 3, 1], [2400, 4, 0.8], [3400, 6, 0.4]], gain: 0.9, rasp: 1, vibrato: 9, attack: 0.05 });
      return;
    }
    this._voice(o, {
      dur: rand(0.7, 1.0),
      f0,
      f0End: f0 * 0.6,
      formants: [[900, 3, 1], [1500, 4, 0.7], [2600, 6, 0.3]],
      gain: 0.9,
      rasp: 0.9,
      vibrato: 7,
      attack: 0.03,
    });
  }

  // The lunge, just before the grab.
  snarl(pos) {
    const o = this._out(pos, 16, 0.6);
    if (!o) return;
    const f0 = rand(140, 180);
    this._voice(o, { dur: 0.4, f0, f0End: f0 * 1.2, formants: [[700, 3, 1], [1300, 4, 0.6]], gain: 1, rasp: 1, attack: 0.02 });
  }

  // A brute's fists coming down: a grunt, a whoosh, a heavy thud.
  slam(pos) {
    const o = this._out(pos, 30, 0.9);
    if (!o) return;
    this._voice(o, { dur: 0.45, f0: 75, f0End: 60, formants: [[500, 4, 1], [900, 5, 0.5]], gain: 0.8, rasp: 0.8, attack: 0.02 });
    this._noise(o, { dur: 0.18, type: 'bandpass', freq: 600, freqEnd: 200, q: 1, gain: 0.5 });
    this._noise(o, { at: 0.05, dur: 0.25, type: 'lowpass', freq: 300, gain: 1.1 });
    this._tone(o, { at: 0.05, dur: 0.25, freq: 70, freqEnd: 35, gain: 1 });
  }

  fleshHit(pos, headshot) {
    const o = this._out(pos, 30, 0.6);
    if (!o) return;
    this._noise(o, { dur: 0.08, type: 'lowpass', freq: 500, gain: 1 });
    this._noise(o, { at: 0.01, dur: 0.16, type: 'bandpass', freq: 1300, freqEnd: 280, q: 3, gain: 0.6 }); // squelch
    if (headshot) this._noise(o, { dur: 0.05, type: 'bandpass', freq: 2200, q: 2, gain: 0.8 }); // crack
  }

  wallHit(pos) {
    const o = this._out(pos, 30, 0.35);
    if (!o) return;
    this._noise(o, { dur: 0.03, type: 'highpass', freq: 3000, gain: 0.7 });
    if (Math.random() < 0.35) this._tone(o, { at: 0.01, dur: 0.18, freq: rand(2200, 3200), freqEnd: 1600, gain: 0.12 }); // ricochet
  }

  bodyFall(pos) {
    const o = this._out(pos, 24, 0.5);
    if (!o) return;
    this._noise(o, { dur: 0.25, type: 'lowpass', freq: 380, gain: 1 });
    this._tone(o, { dur: 0.2, freq: 70, freqEnd: 40, gain: 0.7 });
  }

  // ------------------------------------------------------------ grabbed

  bite() {
    const o = this._out(null, 0, 0.8);
    if (!o) return;
    for (let i = 0; i < 4; i++) {
      this._noise(o, { at: i * 0.045, dur: 0.05, type: 'bandpass', freq: rand(1200, 2200), q: 2, gain: 0.8 }); // crunch
    }
    this._noise(o, { at: 0.05, dur: 0.3, type: 'bandpass', freq: 900, freqEnd: 250, q: 2, gain: 0.6 }); // squelch
    this._voice(o, { dur: 0.35, f0: 190, f0End: 150, formants: [[750, 4, 1], [1200, 5, 0.5]], gain: 0.5, rasp: 0.4, attack: 0.01 }); // your cry
  }

  breakFree() {
    const o = this._out(null, 0, 0.6);
    if (!o) return;
    this._voice(o, { dur: 0.25, f0: 140, f0End: 120, formants: [[600, 4, 1], [1000, 5, 0.5]], gain: 0.6, rasp: 0.5, attack: 0.01 }); // grunt
    this._noise(o, { dur: 0.15, type: 'lowpass', freq: 700, gain: 0.6 }); // shove
  }

  tear() {
    const o = this._out(null, 0, 0.9);
    if (!o) return;
    this._noise(o, { dur: 0.7, type: 'bandpass', freq: 1800, freqEnd: 500, q: 1.5, gain: 0.9, attack: 0.05 }); // ripping
    for (let i = 0; i < 5; i++) {
      this._noise(o, { at: 0.1 + i * 0.12, dur: 0.15, type: 'bandpass', freq: rand(400, 900), q: 3, gain: 0.5 });
    }
    this._voice(o, { dur: 0.9, f0: 260, f0End: 160, formants: [[800, 3, 1], [1400, 4, 0.6]], gain: 0.6, rasp: 0.6, attack: 0.02 });
  }

  // ------------------------------------------------------------ feedback

  pickup(type) {
    const o = this._out(null, 0, 0.45);
    if (!o) return;
    if (type === 'bottle') {
      this._tone(o, { dur: 0.08, type: 'sine', freq: 2400, gain: 0.25 });
      this._tone(o, { at: 0.06, dur: 0.1, type: 'sine', freq: 3100, gain: 0.2 });
    } else if (type === 'ammo' || type === 'pistolAmmo') {
      this._noise(o, { dur: 0.04, type: 'bandpass', freq: 2400, q: 5, gain: 0.8 });
      this._noise(o, { at: 0.08, dur: 0.04, type: 'bandpass', freq: 3000, q: 5, gain: 0.7 });
    } else {
      this._tone(o, { dur: 0.18, type: 'triangle', freq: 660, gain: 0.35 });
      this._tone(o, { at: 0.1, dur: 0.3, type: 'triangle', freq: 990, gain: 0.3 });
    }
  }

  escaped() {
    const o = this._out(null, 0, 0.4);
    if (!o) return;
    [523, 659, 784, 1047].forEach((f, i) => this._tone(o, { at: i * 0.12, dur: 0.9, type: 'triangle', freq: f, gain: 0.35, attack: 0.02 }));
  }

  died() {
    const o = this._out(null, 0, 0.5);
    if (!o) return;
    this._tone(o, { dur: 2.5, type: 'sawtooth', freq: 55, freqEnd: 38, gain: 0.25, attack: 0.3 });
    this._tone(o, { dur: 2.5, type: 'sawtooth', freq: 58, freqEnd: 41, gain: 0.2, attack: 0.3 });
  }

  // Low health: a heartbeat that quickens as it gets worse.
  update(dt, healthFrac, alive) {
    if (!this.ctx || !alive || healthFrac > 0.4) {
      this.heartTimer = 0;
      return;
    }
    this.heartTimer -= dt;
    if (this.heartTimer > 0) return;
    this.heartTimer = 0.55 + healthFrac * 1.2;
    const o = this._out(null, 0, 0.5 + (0.4 - healthFrac));
    if (!o) return;
    this._tone(o, { dur: 0.12, freq: 58, freqEnd: 45, gain: 0.9, attack: 0.01 });
    this._tone(o, { at: 0.16, dur: 0.1, freq: 52, freqEnd: 42, gain: 0.6, attack: 0.01 });
  }
}
