import * as THREE from 'three';
import { CONFIG } from './config.js';
import {
  Medium, Palette, createBackground, FoodField,
  Npc, DetritusField, Rubberband, ToxicityZone, PortalField,
} from './world.js';
import { Player, BehaviorProfile } from './player.js';
import { Audio } from './audio.js';

THREE.ColorManagement.enabled = false;

// ─── Pipeline ──────────────────────────────────────────────────────────────
class Pipeline {
  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    document.body.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(65, 1, 0.1, 400);
    this.palette = new Palette(42);

    this.postScene = new THREE.Scene();
    this.postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.postMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uTime: { value: 0 },
        uHurt: { value: 0 },
        uToxTint: { value: 0 },
        uFade: { value: 0 },
        uRemixFade: { value: 0 },
        uLowHp: { value: 0 },
        uNight: { value: 0 },
      },
      vertexShader: POST_VERT,
      fragmentShader: POST_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMaterial));

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }
  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const ih = CONFIG.render.internalHeight;
    const iw = Math.max(1, Math.round((w / h) * ih));
    if (!this.rt) {
      this.rt = new THREE.WebGLRenderTarget(iw, ih, {
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: true,
      });
      this.postMaterial.uniforms.tDiffuse.value = this.rt.texture;
    } else this.rt.setSize(iw, ih);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  setHurt(v) { this.postMaterial.uniforms.uHurt.value = v; }
  setToxTint(v) { this.postMaterial.uniforms.uToxTint.value = v; }
  setFade(v) { this.postMaterial.uniforms.uFade.value = v; }
  setRemixFade(v) { this.postMaterial.uniforms.uRemixFade.value = v; }
  setLowHp(v) { this.postMaterial.uniforms.uLowHp.value = v; }
  setNight(v) { this.postMaterial.uniforms.uNight.value = v; }
  render(dt, t) {
    this.palette.update(dt);
    this.postMaterial.uniforms.uTime.value = t;
    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.postScene, this.postCamera);
  }
}

const POST_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// VHS-educational post-processing
const POST_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform float uTime;
  uniform float uHurt;
  uniform float uToxTint;
  uniform float uFade;
  uniform float uRemixFade;
  uniform float uLowHp;
  uniform float uNight;
  varying vec2 vUv;

  float bayer4(vec2 p) {
    ivec2 i = ivec2(mod(p, 4.0));
    float m[16] = float[16](
       0.0,  8.0,  2.0, 10.0,
      12.0,  4.0, 14.0,  6.0,
       3.0, 11.0,  1.0,  9.0,
      15.0,  7.0, 13.0,  5.0
    );
    return m[i.y * 4 + i.x] / 16.0 - 0.5;
  }

  void main() {
    // vertical hold wobble
    float wobble = sin(vUv.y * 8.0 + uTime * 1.2) * 0.0009;
    vec2 uv = vUv + vec2(wobble, 0.0);

    // chroma bleed
    float sh = 0.0042;
    vec3 c;
    c.r = texture2D(tDiffuse, uv + vec2(sh, 0.0)).r;
    c.g = texture2D(tDiffuse, uv).g;
    c.b = texture2D(tDiffuse, uv - vec2(sh, 0.0)).b;

    // scanlines
    float scan = sin(gl_FragCoord.y * 3.14159 * 0.5) * 0.5 + 0.5;
    c *= mix(0.90, 1.0, scan);

    // tape vignette
    vec2 d = uv - 0.5;
    float v = smoothstep(1.0, 0.28, length(d));
    c *= mix(0.30, 1.0, v);

    // tracking band
    float bandY = fract(uTime * 0.13);
    float bandDist = abs(fract(uv.y - bandY + 0.5) - 0.5);
    float band = smoothstep(0.035, 0.0, bandDist);
    float bandGate = step(0.55, fract(sin(floor(uTime * 0.13) * 23.0) * 43758.5453));
    c += vec3(band * bandGate * 0.07);

    // tape dropout (horizontal white streak)
    float dropSeed = fract(sin(floor(uTime * 2.5) * 47.0) * 43847.13);
    float dropLine = smoothstep(0.006, 0.0, abs(vUv.y - dropSeed));
    float dropOn = step(0.88, fract(sin(floor(uTime * 2.5) * 23.0) * 43758.5453));
    float dropX = smoothstep(0.15, 0.4, vUv.x);
    c += vec3(0.28) * dropLine * dropOn * dropX;

    // head-switching noise at bottom (classic VHS)
    float hs = smoothstep(0.022, 0.0, 1.0 - vUv.y);
    float hsNoise = fract(sin(gl_FragCoord.x * 12.9898 + uTime * 100.0) * 43758.5453);
    c = mix(c, vec3(hsNoise * 0.55 + 0.25), hs * 0.85);

    // row-level tape noise inside the band
    float rowNoise = fract(sin(gl_FragCoord.y * 12.9898 + uTime * 7.0) * 43758.5453);
    float noiseGate = step(0.997, fract(sin(floor(uTime * 8.0) * 47.0) * 43847.13));
    c += vec3((rowNoise - 0.5) * 0.18 * noiseGate * band);

    // dither + quantize (dated-digital)
    c += bayer4(gl_FragCoord.xy) * 0.022;
    c = floor(c * 28.0 + 0.5) / 28.0;

    // grain
    float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) + uTime * 0.03);
    c += (n - 0.5) * 0.014;

    // phosphor bias
    c = mix(c, c * vec3(0.92, 1.04, 0.96), 0.55);

    // night tint (H)
    c = mix(c, c * vec3(0.55, 0.6, 0.95), uNight * 0.55);

    // state overlays
    c = mix(c, vec3(0.55, 0.05, 0.05), uHurt * 0.7);
    c = mix(c, vec3(0.45, 0.05, 0.55), uToxTint * 0.5);
    c = mix(c, vec3(0.0), uFade);
    c = mix(c, vec3(0.05, 0.0, 0.12), uRemixFade);
    float lowPulse = sin(uTime * 5.0) * 0.5 + 0.5;
    c = mix(c, vec3(0.45, 0.02, 0.05), uLowHp * lowPulse * 0.35);

    gl_FragColor = vec4(c, 1.0);
  }
`;

// ─── Setup ─────────────────────────────────────────────────────────────────
const pipeline = new Pipeline();
const { scene, camera, palette } = pipeline;

const medium = new Medium();
const background = createBackground(palette);
scene.add(background);

const food = new FoodField(scene, palette, 99);
const behavior = new BehaviorProfile(CONFIG.behavior.rate, CONFIG.behavior.pulseDecay);
const player = new Player(scene, palette.uniformArray, behavior);
const rubber = new Rubberband();
const toxicity = new ToxicityZone();
const detritus = new DetritusField(scene, palette);
const portals = new PortalField(scene, palette);
const audio = new Audio();

food.seedAround(player.position, 3, 1.8);

// ─── NPC management ────────────────────────────────────────────────────────
const npcs = [];

function spawnNpcAt(pos, largeChance) {
  const useLarge = Math.random() < largeChance;
  const type = useLarge ? CONFIG.npc.types[1] : CONFIG.npc.types[0];
  return new Npc(scene, palette, pos, type);
}

function spawnNpc() {
  const chance = player.ecoLevel > CONFIG.npc.largeSpawnEco ? 0.4 : 0.15;
  const a = Math.random() * Math.PI * 2;
  const r = 8 + Math.random() * 12;
  const pos = new THREE.Vector3(
    player.position.x + Math.cos(a) * r,
    (Math.random() - 0.5) * 4,
    player.position.z + Math.sin(a) * r,
  );
  return spawnNpcAt(pos, chance);
}

for (let i = 0; i < CONFIG.npc.count; i++) npcs.push(spawnNpc());

// коллбэк при смерти NPC (пищевая сеть) — спавн детрита
const npcCtx = {
  food,
  npcs,
  onNpcKilled: (npc, info) => {
    if (info && info.pos) detritus.spawn(info.pos, palette, info.eco || 0.1);
  },
};

// ─── Portals: 3 штуки с разными пресетами (D) ─────────────────────────────
function pickPresetFor(dominant) {
  if (dominant === 'predation' || dominant === 'armor' || dominant === 'toxicity') return 'DENSE';
  if (dominant === 'sessility' || dominant === 'chemosynthesis' || dominant === 'photosynthesis') return 'VOID';
  if (dominant === 'motility' || dominant === 'evasion') return 'BLOOM';
  return 'BASE';
}

function spawnPortalsNear(center) {
  const dom = behavior.dominant();
  const match = pickPresetFor(dom);
  const others = CONFIG.remix.presets.map(p => p.name).filter(n => n !== match);
  // один «под игрока», два других — случайные
  const names = [match,
    others[Math.floor(Math.random() * others.length)],
    others[Math.floor(Math.random() * others.length)]];
  for (let i = 0; i < CONFIG.portals.count; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = CONFIG.portals.spawnDistanceMin +
      Math.random() * (CONFIG.portals.spawnDistanceMax - CONFIG.portals.spawnDistanceMin);
    const pos = new THREE.Vector3(
      center.x + Math.cos(a) * r,
      center.y + (Math.random() - 0.5) * 4,
      center.z + Math.sin(a) * r,
    );
    portals.spawnWithPreset(pos, palette, names[i] || 'BASE');
  }
}

spawnPortalsNear(player.position);

// ─── VHS educational overlay ──────────────────────────────────────────────
const vhsEl = document.getElementById('vhs');
const vhsCaptionEl = document.getElementById('vhs-caption');
const vhsTimeEl = document.getElementById('vhs-time');
const vhsDateEl = document.getElementById('vhs-date');
const vhsWorldEl = document.getElementById('vhs-world');
const vhsEcoEl = document.getElementById('vhs-eco');

vhsDateEl.textContent = CONFIG.vhs.dateText;

let vhsClock = CONFIG.vhs.clockStart;
let captionTimer = 0;

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function tickClock() {
  vhsClock = (vhsClock + 1) % (24 * 3600);
  const h = Math.floor(vhsClock / 3600);
  const m = Math.floor((vhsClock % 3600) / 60);
  const s = vhsClock % 60;
  vhsTimeEl.textContent = `${pad(h)}:${pad(m)}:${pad(s)}`;
}
tickClock();
setInterval(tickClock, 1000);

function setCaption(text, duration = 3.5, chapter = false) {
  vhsCaptionEl.textContent = text;
  vhsCaptionEl.classList.toggle('chapter', chapter);
  vhsCaptionEl.classList.add('show');
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => vhsCaptionEl.classList.remove('show'), duration * 1000);
}

// стартовый титр
setTimeout(() => setCaption('CHAPTER I — OBSERVATION OF PRIMITIVE ORGANISMS', 5, true), 800);

// ─── Input ─────────────────────────────────────────────────────────────────
const keys = new Set();
let lmbDown = false;
let lmbHeldTime = 0;
let dashPressed = false;
window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'Space') { dashPressed = true; e.preventDefault(); }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
window.addEventListener('mousedown', (e) => { if (e.button === 0) { lmbDown = true; lmbHeldTime = 0; } });
window.addEventListener('mouseup',   (e) => { if (e.button === 0) { lmbDown = false; lmbHeldTime = 0; } });

function readInput() {
  let x = 0, y = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) y -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) y += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
  const len = Math.hypot(x, y);
  if (len > 1) { x /= len; y /= len; }
  return { x, y };
}

// ─── Audio bootstrap ───────────────────────────────────────────────────────
function ensureAudio() { audio.start(); }
window.addEventListener('keydown', ensureAudio, { once: true });
window.addEventListener('mousedown', ensureAudio, { once: true });
window.addEventListener('touchstart', ensureAudio, { once: true });

// ─── Camera ────────────────────────────────────────────────────────────────
const cameraDesired = new THREE.Vector3();
function updateCamera() {
  const dist = CONFIG.camera.distance * Math.cbrt(player.mass);
  cameraDesired.copy(player.position).add(new THREE.Vector3(0, CONFIG.camera.height, dist));
  camera.position.lerp(cameraDesired, CONFIG.camera.followLerp);
  camera.lookAt(player.position);
  background.position.copy(camera.position);
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function findSafeSpawn() {
  const base = player.position.clone();
  for (let i = 0; i < 20; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 3 + Math.random() * 5;
    const p = base.clone().add(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
    const s = medium.sample(p.x, p.y, p.z);
    if (s.toxicity > 0.5) continue;
    let nearEnemy = false;
    for (const npc of npcs) if (npc.alive && npc.type.damage > 0 && npc.position.distanceTo(p) < 6) nearEnemy = true;
    if (!nearEnemy) return p;
  }
  return base;
}

const debugEl = document.getElementById('debug');
const hintEl = document.getElementById('hint');
const hudEl = document.getElementById('hud');
const hudEnergy = document.getElementById('hud-energy');
const hudEnergyVal = document.getElementById('hud-energy-val');
const hudHp = document.getElementById('hud-hp');
const hudHpVal = document.getElementById('hud-hp-val');
const hudStage = document.getElementById('hud-stage');
const hudEco = document.getElementById('hud-eco');
const hudChildren = document.getElementById('hud-children');
const hudDominant = document.getElementById('hud-dominant');

let lastDebugUpdate = 0;
let lastHudUpdate = 0;

setTimeout(() => {
  hintEl.style.transition = 'opacity 2s';
  hintEl.style.opacity = '0';
}, CONFIG.ui.hintTimeout * 1000);

let debugVisible = false;
debugEl.classList.add('hidden');
window.addEventListener('keydown', (e) => {
  if (e.code === 'Backquote') {
    debugVisible = !debugVisible;
    debugEl.classList.toggle('hidden', !debugVisible);
  }
  if (e.code === 'Digit0' || e.code === 'Numpad0') {
    hudEl.classList.toggle('active');
  }
});

// ─── Death memory (F) + «эхо» ─────────────────────────────────────────────
const echoes = []; // { mesh, ttl, maxTtl }

function spawnEcho(pos) {
  const geo = new THREE.IcosahedronGeometry(Math.sqrt(player.mass) * 0.7, 2);
  const mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0.7, 0.9, 0.7),
    transparent: true, opacity: 0.28,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(pos);
  scene.add(mesh);
  echoes.push({ mesh, ttl: 30, maxTtl: 30, geo, mat });
}

let deathCause = null; // 'npc' | 'toxin' | 'starve' | null
let deathMemory = { evasion: 0, toxicity: 0, motility: 0 }; // оставшиеся секунды пульсов

function applyDeathMemory() {
  if (!deathCause) return;
  if (deathCause === 'npc')    { behavior.pulse('evasion', 0.3);    deathMemory.evasion  = 30; }
  if (deathCause === 'toxin')  { behavior.pulse('toxicity', 0.3);   deathMemory.toxicity = 30; }
  if (deathCause === 'drown')  { behavior.pulse('motility', 0.2);   deathMemory.motility = 30; }
  deathCause = null;
}

function tickDeathMemory(dt) {
  for (const k of Object.keys(deathMemory)) {
    if (deathMemory[k] > 0) deathMemory[k] = Math.max(0, deathMemory[k] - dt);
  }
}

// ─── Remix state machine ───────────────────────────────────────────────────
let remixState = 0;
let remixTimer = 0;
let remixFade = 0;
let remixCooldown = 0;
let currentPresetName = CONFIG.remix.presets[0].name;
let pendingPreset = null;
let pendingPresetName = null;

function presetByName(name) {
  return CONFIG.remix.presets.find(p => p.name === name) || CONFIG.remix.presets[0];
}

function applyRemixPreset(preset, name) {
  medium.scaleMul = preset.mediumScale;
  medium.warpMul = preset.mediumWarp;
  palette.reseed(preset.paletteSeed);
  currentPresetName = name;
  vhsWorldEl.textContent = `WORLD: ${name}`;

  // VHS caption при входе в новый мир
  setCaption(`ENTERING ${name} SECTOR`, 4.2, true);
  audio.portal();

  const newPos = new THREE.Vector3(
    (Math.random() - 0.5) * 20,
    (Math.random() - 0.5) * 4,
    (Math.random() - 0.5) * 20,
  );
  player.position.copy(newPos);
  player.mesh.position.copy(newPos);
  player.velocity.set(0, 0, 0);
  player.fade = 0;

  for (let i = 0; i < food.foods.length; i++) {
    const f = food.foods[i];
    if (i < preset.food) {
      f.alive = true;
      f.mesh.visible = true;
      const a = Math.random() * Math.PI * 2;
      const r = 3 + Math.random() * CONFIG.world.foodSpawnRadius;
      f.mesh.position.set(newPos.x + Math.cos(a) * r, newPos.y + (Math.random() - 0.5) * 8, newPos.z + Math.sin(a) * r);
      f.type = food._rollType();
      f.mesh.material.color.copy(food._colorFor(f.type, palette));
      f.energy = 8 + 0.7 * 30;
    } else {
      f.alive = false;
      f.mesh.visible = false;
    }
  }

  for (const item of detritus.items) {
    if (item.alive) { item.alive = false; item.mesh.visible = false; }
  }

  // NPC: пересоздаём
  for (let i = 0; i < npcs.length; i++) {
    const old = npcs[i];
    if (old) { scene.remove(old.mesh); old.mesh.geometry.dispose(); old.mesh.material.dispose(); }
    const a = Math.random() * Math.PI * 2;
    const r = 20 + Math.random() * 15;
    const pos = new THREE.Vector3(newPos.x + Math.cos(a) * r, (Math.random() - 0.5) * 4, newPos.z + Math.sin(a) * r);
    npcs[i] = spawnNpcAt(pos, preset.largeChance);
  }

  portals.clear();
  spawnPortalsNear(newPos);
}

function startRemix(presetName) {
  if (remixState !== 0) return;
  pendingPreset = presetByName(presetName);
  pendingPresetName = presetName;
  remixState = 1;
  remixTimer = 0;
}

// ─── Day/Night cycle (H) ──────────────────────────────────────────────────
let dayPhase = 0;
function updateDayNight(dt) {
  dayPhase = (dayPhase + dt / CONFIG.dayNight.cycle) % 1;
  const s = Math.sin(dayPhase * Math.PI * 2 - Math.PI / 2) * 0.5 + 0.5; // 0..1
  pipeline.setNight(1 - s);
  return s; // 1 = день, 0 = ночь
}

// ─── Combo / pattern tracking (J-lite) ────────────────────────────────────
const patternWindow = 15;
const patternHistory = []; // { field, t }
let comboCount = 0;
let lastComboTime = -99;

function recordPattern(field, t) {
  patternHistory.push({ field, t });
  while (patternHistory.length && t - patternHistory[0].t > patternWindow) patternHistory.shift();
  const unique = new Set(patternHistory.map(p => p.field));
  if (unique.size >= 3 && t - lastComboTime > 12) {
    lastComboTime = t;
    comboCount++;
    // мир реагирует: звук + капшн + портал рядом
    audio.symbiosis();
    setCaption('PATTERN OBSERVED — WORLD RESPONDS', 3.5, false);
    if (comboCount % 3 === 0) {
      // подкидываем портал рядом
      const a = Math.random() * Math.PI * 2;
      const r = 18 + Math.random() * 8;
      const pos = new THREE.Vector3(
        player.position.x + Math.cos(a) * r,
        player.position.y + (Math.random() - 0.5) * 3,
        player.position.z + Math.sin(a) * r,
      );
      const dom = behavior.dominant();
      portals.spawnWithPreset(pos, palette, pickPresetFor(dom));
    }
  }
}

// ─── Main loop ─────────────────────────────────────────────────────────────
let last = performance.now();
let t = 0;
let lmbBiteCd = 0;
let dashCd = 0;
let lastMitosisCount = player.mitosisCount;
let lastStage = player.stage;
let lastDominant = behavior.dominant();
let deadZoneTimers = {};
for (const f of ['predation','herbivory','scavenging','symbiosis','motility',
                 'sessility','armor','toxicity','evasion','photosynthesis','chemosynthesis']) {
  deadZoneTimers[f] = 0;
}

// начальный захват мирового имени
vhsWorldEl.textContent = `WORLD: ${currentPresetName}`;

function frame(now) {
  const dt = Math.min(CONFIG.render.maxDt, (now - last) / 1000);
  last = now;
  t += dt;

  const dayness = updateDayNight(dt);

  // ── Death state ──
  if (player.dead) {
    player.respawnTimer += dt;
    // respawn
    if (player.respawnTimer > CONFIG.player.respawnDelay) {
      const p = findSafeSpawn();
      // F: масса теряется меньше
      player.mass = Math.max(CONFIG.player.massMin, player.mass * (1 - CONFIG.player.deathMassLoss));
      player.respawn(p);
      player.fade = 1;
      applyDeathMemory();
      setCaption('SPECIMEN RE-EMERGES', 3.0, false);
    }
  }

  const input = player.dead ? { x: 0, y: 0 } : readInput();
  const { sample, moving, effects } = player.update(dt, input, medium);
  const ef = effects || player.getEffects();

  tickDeathMemory(dt);

  // metamorphosis / mitosis — VHS captions
  if (player.stage !== lastStage) {
    audio.metamorphosis();
    setCaption(`METAMORPHOSIS — STAGE: ${player.stage.toUpperCase()}`, 3.5, true);
    lastStage = player.stage;
  }
  if (player.mitosisCount > lastMitosisCount) {
    audio.mitosis();
    lastMitosisCount = player.mitosisCount;
  }

  // passive energy modulated by sessility/photosynthesis
  const lightMult = sample.luminosity > 0.6 ? ef.lightMult : 1;
  const darkMult  = sample.luminosity < 0.3 ? ef.darkMult : 1;
  player.energy = Math.min(CONFIG.player.baseEnergy,
    player.energy + sample.chemEnergy * CONFIG.player.passiveGain * ef.passiveMult * lightMult * darkMult * dt);

  // toxicity
  const toxDmg = toxicity.damageAt(sample);
  if (toxDmg > 0 && !player.dead) {
    if (player.takeDamage(toxDmg * dt * ef.armorMult, t)) {
      deathCause = 'toxin';
    }
    behavior.pulse('evasion', CONFIG.toxicity.evasionPulse * dt);
  }

  rubber.update(dt, player.energy / CONFIG.player.baseEnergy, toxDmg > 0);

  behavior.tick(dt, {
    motility: moving,
    sessility: !moving && !player.dead,
    chemosynthesis: sample.chemEnergy > 0.5,
    photosynthesis: sample.luminosity > 0.6,
  });

  // B: dead-zone — поле, которое не растёт > 60с, медленно ржавеет
  const dom = behavior.dominant();
  for (const f of Object.keys(deadZoneTimers)) {
    if (behavior[f] > 0.05 && behavior.pulses[f] > 0.05) deadZoneTimers[f] = 0;
    else deadZoneTimers[f] += dt;
    if (deadZoneTimers[f] > CONFIG.behavior.deadZoneTime) {
      behavior[f] = Math.max(0, behavior[f] - CONFIG.behavior.deadZoneDecay * dt);
    }
  }

  // доминирующий сдвиг — диегетика
  if (dom !== lastDominant) {
    lastDominant = dom;
    // только если не «пустое» доминирование
    if (behavior[dom] > 0.25) {
      audio.metamorphosis();
      setCaption(`DOMINANT TRAIT: ${dom.toUpperCase()}`, 2.6, false);
    }
  }

  // audio map
  const portalDist = portals.closestDistance(player.position);
  const portalProx = portalDist < Infinity ? Math.max(0, 1 - portalDist / CONFIG.portals.spawnDistanceMax) : 0;
  let largeProx = 0;
  for (const npc of npcs) {
    if (!npc.alive || npc.type.damage <= 0) continue;
    const d = npc.position.distanceTo(player.position);
    if (d < 20) largeProx = Math.max(largeProx, 1 - d / 20);
  }
  audio.updateAmbient(sample.density, sample.toxicity, portalProx, largeProx, dom);

  // ── Auto-eat (organic + toxic) ──
  if (!player.dead) {
    const bite = food.tryEat(player.position, CONFIG.player.eatRange, false);
    if (bite.energy > 0) {
      player.feed(bite.energy * ef.eatMult);
      behavior.pulse('herbivory', CONFIG.behavior.foodPulse);
      audio.eat();
      if (bite.energy > 20) recordPattern('herbivory', t);
    }
    if (bite.toxicCount > 0) behavior.pulse('toxicity', CONFIG.food.toxicPulse * bite.toxicCount);
  }

  // ── LMB bite ──
  lmbBiteCd = Math.max(0, lmbBiteCd - dt);
  if (lmbDown) lmbHeldTime += dt;
  if (lmbDown && lmbBiteCd <= 0 && !player.dead && player.energy > CONFIG.player.lmbBiteCost) {
    const r = CONFIG.player.lmbBiteRange;
    const bite = food.tryEat(player.position, r, true);
    let gained = bite.energy * ef.eatMult;
    if (bite.mineralCount > 0) {
      player.ecoLevel += CONFIG.food.mineralEcoGain * bite.mineralCount;
      behavior.pulse('armor', CONFIG.food.mineralArmorPulse * bite.mineralCount);
      audio.mineral();
    }
    if (bite.toxicCount > 0) behavior.pulse('toxicity', CONFIG.food.toxicPulse * bite.toxicCount);

    for (const npc of npcs) {
      if (npc.alive && npc.position.distanceTo(player.position) < r) {
        const c = npc.kill();
        detritus.spawn(c.pos, palette, c.eco);
        gained += npc.type.energy * ef.biteMult;
        behavior.pulse('predation', CONFIG.behavior.npcPulse);
        recordPattern('predation', t);
        npc.attached = false;
        npc.symbiosisTime = 0;
      }
    }
    if (gained === 0 && lmbHeldTime > 0.8 && player.children.length > 0) {
      const ate = player.tryEatChildren(player.position, r);
      if (ate > 0) { gained += ate; behavior.pulse('predation', 0.3); }
    }
    if (gained > 0 || bite.mineralCount > 0) {
      if (gained > 0) player.feed(gained);
      if (bite.energy > 0) behavior.pulse('herbivory', CONFIG.behavior.foodPulse);
      player.energy -= CONFIG.player.lmbBiteCost;
      lmbBiteCd = CONFIG.player.lmbBiteCooldown;
      audio.bite();
    }
  }

  // ── Space dash ──
  dashCd = Math.max(0, dashCd - dt);
  if (dashPressed && dashCd <= 0 && !player.dead && player.energy > CONFIG.player.dashCost * ef.dashCostMult) {
    const dir = new THREE.Vector3(input.x, 0, input.y);
    if (dir.lengthSq() > 0.001) dir.normalize(); else dir.set(0, 0, -1);
    player.velocity.addScaledVector(dir, CONFIG.player.dashSpeed);
    player.energy -= CONFIG.player.dashCost * ef.dashCostMult;
    dashCd = CONFIG.player.dashCooldown * ef.dashCdMult;
    behavior.pulse('motility', 0.25);
  }
  dashPressed = false;

  // ── NPC ecosystem (C) ──
  // чистим мёртвых и перерождаем, соблюдая min/max
  let aliveCount = 0;
  for (const npc of npcs) if (npc.alive) aliveCount++;

  for (let i = 0; i < npcs.length; i++) {
    const npc = npcs[i];
    npc.update(dt, player.position, npcCtx);

    if (!npc.alive) {
      // respawn только если aliveCount ниже минимума
      npc.deadTimer = (npc.deadTimer || 0) + dt;
      if (npc.deadTimer > CONFIG.npc.respawnDelay && aliveCount < CONFIG.npc.minCount) {
        // спавним нового small/large вокруг игрока
        const a = Math.random() * Math.PI * 2;
        const r = 15 + Math.random() * 15;
        const pos = new THREE.Vector3(
          player.position.x + Math.cos(a) * r,
          (Math.random() - 0.5) * 4,
          player.position.z + Math.sin(a) * r,
        );
        const largeChance = player.ecoLevel > CONFIG.npc.largeSpawnEco ? 0.4 : 0.15;
        const useLarge = Math.random() < largeChance;
        const type = useLarge ? CONFIG.npc.types[1] : CONFIG.npc.types[0];
        npc.respawn(pos, type);
        npc.deadTimer = 0;
        aliveCount++;
      }
      continue;
    }

    // атака игрока
    if (npc.type.damage > 0 && !player.dead && !npc.attached && npc.tryHit()) {
      const d = npc.position.distanceTo(player.position);
      if (d < npc.type.size + 0.6) {
        const dmg = npc.type.damage * ef.armorMult;
        if (player.takeDamage(dmg, t)) {
          deathCause = 'npc';
          behavior.pulse('evasion', CONFIG.behavior.npcPulse * 0.5);
          behavior.pulse('armor', 0.2);
          audio.damage();
          pipeline.setHurt(1);
        }
      }
    }

    // симбиоз
    if (npc.type.damage > 0 && !player.dead) {
      const d = npc.position.distanceTo(player.position);
      const symRange = CONFIG.colony.symbiosisRange * ef.symbiosisRate;
      if (d < symRange) {
        npc.symbiosisTime += dt * ef.symbiosisRate;
        if (npc.symbiosisTime >= CONFIG.colony.symbiosisDuration) {
          if (!npc.attached) {
            audio.symbiosis();
            setCaption('SYMBIONT ATTACHED', 2.8, false);
            recordPattern('symbiosis', t);
          }
          npc.attached = true;
        }
      } else if (d > CONFIG.colony.symbiosisBreakRange) {
        npc.symbiosisTime = Math.max(0, npc.symbiosisTime - dt * 2);
        npc.attached = false;
      }
      if (npc.attached && d < CONFIG.symbiontDefense.range) {
        player.energy = Math.min(CONFIG.player.baseEnergy,
          player.energy + CONFIG.colony.symbiosisEnergyPerSec * dt);
        behavior.pulse('symbiosis', CONFIG.colony.symbiosisPulseRate * dt);
      }
    }

    // NPC ↔ NPC столкновения / поедание — уже в npc.update через ctx
  }

  // ── Детрит pickup ──
  if (!player.dead) {
    const scav = detritus.tryPickup(player.position, CONFIG.detritus.pickupRange);
    if (scav > 0) {
      player.feed(scav);
      behavior.pulse('scavenging', CONFIG.behavior.scavengingPulse);
      recordPattern('scavenging', t);
    }
  }

  // ── Эхо (F) ──
  for (let i = echoes.length - 1; i >= 0; i--) {
    const e = echoes[i];
    e.ttl -= dt;
    const k = Math.max(0, e.ttl / e.maxTtl);
    e.mat.opacity = 0.28 * k;
    e.mesh.scale.setScalar(1 + (1 - k) * 0.15);
    if (e.ttl <= 0) {
      scene.remove(e.mesh);
      e.geo.dispose();
      e.mat.dispose();
      echoes.splice(i, 1);
    }
  }

  // ── Проверка смерти ──
  if (!player.dead && player.hp <= 0) {
    player.kill();
    audio.death();
    spawnEcho(player.position.clone());
    setCaption('SPECIMEN LOST — TAPE CONTINUES', 3.5, false);
  }

  // ── Портал: вход (D) ──
  remixCooldown = Math.max(0, remixCooldown - dt);
  if (!player.dead && remixState === 0 && remixCooldown <= 0) {
    const hit = portals.tryEnter(player.position);
    if (hit) {
      startRemix(hit.preset);
      remixCooldown = CONFIG.portals.cooldown;
    }
  }

  // remix state machine
  if (remixState === 1) {
    remixTimer += dt;
    remixFade = Math.min(1, remixTimer / CONFIG.remix.fadeDuration);
    if (remixTimer >= CONFIG.remix.fadeDuration) {
      applyRemixPreset(pendingPreset, pendingPresetName);
      remixState = 2;
      remixTimer = 0;
    }
  } else if (remixState === 2) {
    remixTimer += dt;
    remixFade = Math.max(0, 1 - remixTimer / CONFIG.remix.fadeDuration);
    if (remixTimer >= CONFIG.remix.fadeDuration) {
      remixState = 0;
      remixFade = 0;
      pendingPreset = null;
      pendingPresetName = null;
    }
  }

  // ── Обновления полей ──
  food.update(t);
  food.respawnDead(player.position, palette, player.ecoLevel, medium, rubber.offset);
  detritus.update(dt);
  portals.update(dt, t, player.position);

  // ── Камера ──
  updateCamera();

  // ── Post-processing uniforms ──
  pipeline.setHurt(Math.max(player.damageFlash * 0.8, 0));
  pipeline.setToxTint(Math.min(1, sample.toxicity * 0.9));
  pipeline.setFade(player.fade > 0 ? Math.min(1, player.fade) * 0.6 : 0);
  pipeline.setRemixFade(remixFade * 0.85);
  pipeline.setLowHp(player.hp < CONFIG.player.maxHp * 0.3 && !player.dead
    ? 1 - player.hp / (CONFIG.player.maxHp * 0.3) : 0);

  // player.fade затухает
  if (player.fade > 0) player.fade = Math.max(0, player.fade - dt * CONFIG.player.fadeSpeed);

  // ── VHS eco-счётчик (обновляем редко) ──
  lastHudUpdate += dt;
  if (lastHudUpdate > 0.15) {
    lastHudUpdate = 0;
    vhsEcoEl.textContent = `ECO ${player.ecoLevel.toFixed(3)}`;
    hudEco.textContent = player.ecoLevel.toFixed(3);
    hudStage.textContent = player.stage;
    hudChildren.textContent = `${player.children.length}/${CONFIG.colonyChild.maxChildren}`;
    hudDominant.textContent = behavior.dominant();
    hudEnergy.style.width = `${Math.round((player.energy / CONFIG.player.baseEnergy) * 100)}%`;
    hudEnergyVal.textContent = Math.round(player.energy);
    hudHp.style.width = `${Math.round((player.hp / CONFIG.player.maxHp) * 100)}%`;
    hudHpVal.textContent = Math.round(player.hp);
  }

  // ── Debug ──
  lastDebugUpdate += dt;
  if (debugVisible && lastDebugUpdate > 0.25) {
    lastDebugUpdate = 0;
    const lines = [];
    lines.push(`world: ${currentPresetName}  dayPhase: ${dayPhase.toFixed(2)}  day: ${dayness.toFixed(2)}`);
    lines.push(`stage: ${player.stage}  eco: ${player.ecoLevel.toFixed(3)}  mass: ${player.mass.toFixed(2)}`);
    lines.push(`energy: ${player.energy.toFixed(1)}  hp: ${player.hp.toFixed(1)}  dead: ${player.dead}`);
    lines.push(`npcs alive: ${npcs.filter(n => n.alive).length}/${npcs.length}  detritus: ${detritus.items.filter(i => i.alive).length}`);
    lines.push(`portals: ${portals.portals.length}  remix: ${remixState}`);
    lines.push(`patterns: ${patternHistory.length}  combos: ${comboCount}`);
    lines.push('');
    lines.push('behavior:');
    for (const f of ['predation','herbivory','scavenging','symbiosis','motility',
                     'sessility','armor','toxicity','evasion','photosynthesis','chemosynthesis']) {
      const v = behavior[f].toFixed(2);
      const p = behavior.pulses[f].toFixed(2);
      const dz = deadZoneTimers[f].toFixed(0);
      lines.push(`  ${f.padEnd(14)} ${v}  pulse ${p}  dead ${dz}s`);
    }
    debugEl.textContent = lines.join('\n');
  }

  // ── Render ──
  pipeline.render(dt, t);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);