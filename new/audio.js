import { CONFIG } from './config.js';

export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.started = false;
    this.enabled = CONFIG.audio.enabled;
    this.droneNodes = [];
    this.noiseFilter = null;
  }
  start() {
    if (this.started || !this.enabled) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = CONFIG.audio.masterGain;
      this.master.connect(this.ctx.destination);
      this.started = true;
      this._startAmbient();
    } catch (e) { this.enabled = false; }
  }
  _startAmbient() {
    const ctx = this.ctx;
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = CONFIG.audio.ambientBaseFreq * (1 + i * 0.5);
      const gain = ctx.createGain();
      gain.gain.value = 0.12;
      osc.connect(gain).connect(this.master);
      osc.start();
      this.droneNodes.push({ osc, gain });
    }
    const bufSize = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 800;
    filter.Q.value = 0.8;
    const ng = ctx.createGain();
    ng.gain.value = 0.05;
    noise.connect(filter).connect(ng).connect(this.master);
    noise.start();
    this.noiseFilter = filter;
  }
  updateAmbient(density, toxicity) {
    if (!this.started) return;
    const now = this.ctx.currentTime;
    for (let i = 0; i < this.droneNodes.length; i++) {
      const n = this.droneNodes[i];
      const f = CONFIG.audio.ambientBaseFreq * (1 + i * 0.5) * (0.8 + density * 0.4);
      n.osc.frequency.setTargetAtTime(f, now, 0.2);
      n.gain.gain.setTargetAtTime(0.08 + density * 0.08, now, 0.3);
    }
    if (this.noiseFilter) {
      this.noiseFilter.frequency.setTargetAtTime(400 + density * 1200 + toxicity * 800, now, 0.3);
    }
  }
  _blip(freq, dur, type = 'sine', gainV = 0.3) {
    if (!this.started) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(gainV, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    osc.connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + dur + 0.05);
  }
  _sweep(f0, f1, dur, type = 'sine', gainV = 0.25) {
    if (!this.started) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), now + dur);
    gain.gain.setValueAtTime(gainV, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    osc.connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + dur + 0.05);
  }
  eat()      { this._blip(720 + Math.random() * 120, 0.12, 'sine', 0.15); }
  bite()     { this._sweep(400, 120, 0.18, 'sawtooth', 0.18); }
  damage()   { this._sweep(180, 60, 0.35, 'square', 0.22); }
  mitosis()  { this._blip(660, 0.25); setTimeout(() => this._blip(990, 0.3), 70); }
  symbiosis(){ this._blip(440, 0.4); setTimeout(() => this._blip(554, 0.4), 100); setTimeout(() => this._blip(660, 0.6), 200); }
  portal()   { this._sweep(200, 1200, 0.7, 'triangle', 0.28); }
  death()    { this._sweep(400, 40, 1.2, 'sine', 0.28); }
}