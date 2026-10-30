import * as THREE from 'three';
import { CONFIG } from './config.js';
import {
  Medium, Palette, createBackground, FoodField,
  Npc, DetritusField, Rubberband, ToxicityZone,
} from './world.js';
import { Player, BehaviorProfile } from './player.js';

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

const POST_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform float uTime;
  uniform float uHurt;
  uniform float uToxTint;
  uniform float uFade;
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
    vec3 c = texture2D(tDiffuse, vUv).rgb;
    float sh = 0.0025;
    c.r = mix(c.r, texture2D(tDiffuse, vUv + vec2(sh, 0.0)).r, 0.5);
    c.b = mix(c.b, texture2D(tDiffuse, vUv - vec2(sh, 0.0)).b, 0.5);
    vec2 d = vUv - 0.5;
    float v = smoothstep(0.95, 0.25, length(d));
    c *= mix(0.35, 1.0, v);
    c += bayer4(gl_FragCoord.xy) * 0.055;
    c = floor(c * 32.0 + 0.5) / 32.0;
    float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) + uTime * 0.03);
    c += (n - 0.5) * 0.025;
    c = mix(c, vec3(0.55, 0.05, 0.05), uHurt * 0.7);
    c = mix(c, vec3(0.45, 0.05, 0.55), uToxTint * 0.5);
    c = mix(c, vec3(0.0), uFade);
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

food.seedAround(player.position, 3, 1.8);

function spawnNpc() {
  const useLarge = player.ecoLevel > CONFIG.npc.largeSpawnEco && Math.random() < 0.4;
  const type = useLarge ? CONFIG.npc.types[1] : CONFIG.npc.types[0];
  const a = Math.random() * Math.PI * 2;
  const r = 8 + Math.random() * 4;
  const pos = new THREE.Vector3(
    player.position.x + Math.cos(a) * r,
    (Math.random() - 0.5) * 4,
    player.position.z + Math.sin(a) * r,
  );
  return new Npc(scene, palette, pos, type);
}
const npcs = [spawnNpc(), spawnNpc(), spawnNpc()];

// ─── Input ─────────────────────────────────────────────────────────────────
const keys = new Set();
let lmbDown = false;
let dashPressed = false;
window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'Space') { dashPressed = true; e.preventDefault(); }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
window.addEventListener('mousedown', (e) => { if (e.button === 0) lmbDown = true; });
window.addEventListener('mouseup', (e) => { if (e.button === 0) lmbDown = false; });

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
let lastDebugUpdate = 0;

// ─── Main loop ─────────────────────────────────────────────────────────────
let last = performance.now();
let t = 0;
let lmbBiteCd = 0;
let dashCd = 0;

function frame(now) {
  const dt = Math.min(CONFIG.render.maxDt, (now - last) / 1000);
  last = now;
  t += dt;

  const input = player.dead ? { x: 0, y: 0 } : readInput();
  const { sample, moving } = player.update(dt, input, medium);

  player.energy = Math.min(CONFIG.player.baseEnergy, player.energy + sample.chemEnergy * CONFIG.player.passiveGain * dt);

  const toxDmg = toxicity.damageAt(sample);
  let tookDamage = false;
  if (toxDmg > 0 && !player.dead) {
    if (player.takeDamage(toxDmg * dt, t)) tookDamage = true;
    behavior.pulse('evasion', CONFIG.toxicity.evasionPulse * dt);
  }

  rubber.update(dt, player.energy / CONFIG.player.baseEnergy, tookDamage);

  behavior.tick(dt, {
    motility: moving,
    sessility: !moving && !player.dead,
    chemosynthesis: sample.chemEnergy > 0.5,
    photosynthesis: sample.luminosity > 0.6,
  });

  // auto-eat food on touch
  if (!player.dead) {
    const bite = food.tryEat(player.position, CONFIG.player.eatRange);
    if (bite.energy > 0) {
      player.feed(bite.energy);
      behavior.pulse('herbivory', CONFIG.behavior.foodPulse);
    }
    if (bite.toxicCount > 0) behavior.pulse('toxicity', CONFIG.food.toxicPulse * bite.toxicCount);
  }

  // LMB bite
  lmbBiteCd = Math.max(0, lmbBiteCd - dt);
  if (lmbDown && lmbBiteCd <= 0 && !player.dead && player.energy > CONFIG.player.lmbBiteCost) {
    const r = CONFIG.player.lmbBiteRange;
    const bite = food.tryEat(player.position, r);
    let gained = bite.energy;
    if (bite.toxicCount > 0) behavior.pulse('toxicity', CONFIG.food.toxicPulse * bite.toxicCount);
    for (const npc of npcs) {
      if (npc.alive && npc.position.distanceTo(player.position) < r) {
        const c = npc.kill();
        detritus.spawn(c.pos, palette, c.eco);
        gained += npc.type.energy;
        behavior.pulse('predation', CONFIG.behavior.npcPulse);
        npc.attached = false;
        npc.symbiosisTime = 0;
      }
    }
    if (gained > 0) {
      player.feed(gained);
      if (bite.energy > 0) behavior.pulse('herbivory', CONFIG.behavior.foodPulse);
      player.energy -= CONFIG.player.lmbBiteCost;
      lmbBiteCd = CONFIG.player.lmbBiteCooldown;
    }
  }

  // Space dash
  dashCd = Math.max(0, dashCd - dt);
  if (dashPressed && dashCd <= 0 && !player.dead && player.energy > CONFIG.player.dashCost) {
    const dir = new THREE.Vector3(input.x, 0, input.y);
    if (dir.lengthSq() > 0.001) dir.normalize(); else dir.set(0, 0, -1);
    player.velocity.addScaledVector(dir, CONFIG.player.dashSpeed);
    player.energy -= CONFIG.player.dashCost;
    dashCd = CONFIG.player.dashCooldown;
  }
  dashPressed = false;

  // NPCs
  for (const npc of npcs) {
    npc.update(dt, player.position);
    if (!npc.alive) {
      npc.respawnTimer = (npc.respawnTimer || 0) + dt;
      continue;
    }
    if (npc.type.damage > 0 && !player.dead && !npc.attached && npc.tryHit()) {
      const d = npc.position.distanceTo(player.position);
      if (d < npc.type.size + 0.6) {
        if (player.takeDamage(npc.type.damage, t)) {
          behavior.pulse('evasion', CONFIG.behavior.npcPulse * 0.5);
          behavior.pulse('armor', 0.2);
        }
      }
    }
    // symbiosis
    if (npc.type.damage > 0 && !player.dead) {
      const d = npc.position.distanceTo(player.position);
      if (d < CONFIG.colony.symbiosisRange) {
        npc.symbiosisTime += dt;
        if (npc.symbiosisTime >= CONFIG.colony.symbiosisDuration) npc.attached = true;
      } else if (d > CONFIG.colony.symbiosisBreakRange) {
        npc.symbiosisTime = Math.max(0, npc.symbiosisTime - dt * 2);
        npc.attached = false;
      }
      if (npc.attached && d < CONFIG.colony.symbiosisBreakRange) {
        player.energy = Math.min(CONFIG.player.baseEnergy, player.energy + CONFIG.colony.symbiosisEnergyPerSec * dt);
        behavior.pulse('symbiosis', CONFIG.colony.symbiosisPulseRate * dt);
      }
    }
  }

  // respawn NPCs
  for (let i = 0; i < npcs.length; i++) {
    if (!npcs[i].alive && (npcs[i].respawnTimer || 0) >= CONFIG.npc.respawnDelay) {
      npcs[i] = spawnNpc();
    }
  }

  // detritus
  detritus.update(dt);
  if (!player.dead) {
    const picked = detritus.tryPickup(player.position, CONFIG.detritus.pickupRange);
    if (picked > 0) {
      player.feed(picked);
      behavior.pulse('scavenging', CONFIG.behavior.scavengingPulse);
    }
  }

  // food respawn
  food.respawnDead(player.position, palette, player.ecoLevel, medium, rubber.offset);
  food.update(t);

  // death / respawn
  if (player.hp <= 0 && !player.dead) player.kill();
  if (player.dead) {
    player.respawnTimer += dt;
    player.fade = Math.min(1, player.fade + dt * CONFIG.player.fadeSpeed);
    if (player.respawnTimer >= CONFIG.player.respawnDelay) player.respawn(findSafeSpawn());
  } else {
    player.fade = Math.max(0, player.fade - dt * CONFIG.player.fadeSpeed * 0.5);
  }

  updateCamera();

  background.material.uniforms.uTime.value = t;

  pipeline.setHurt(player.damageFlash);
  pipeline.setToxTint(Math.max(0, (sample.toxicity - 0.5) * 2));
  pipeline.setFade(player.fade);
  pipeline.render(dt, t);

  // debug
  if (now - lastDebugUpdate > 60) {
    lastDebugUpdate = now;
    let s = '';
    s += `ecoLevel: ${player.ecoLevel.toFixed(3)}   stage: ${player.stage}\n`;
    s += `mass:     ${player.mass.toFixed(2)}   mitosis ×${player.mitosisCount}\n`;
    s += `energy:   ${player.energy.toFixed(0)}/${CONFIG.player.baseEnergy}   hp: ${player.hp.toFixed(0)}/${CONFIG.player.maxHp}\n`;
    s += `speed:    ${player.velocity.length().toFixed(2)}   moving: ${moving ? 'yes' : 'no'}\n`;
    s += `rubber:   ${rubber.offset.toFixed(2)}   colony: ${player.colonyFactor.toFixed(2)}\n`;
    s += `dominant: ${behavior.dominant()}\n`;
    s += `pos:      (${player.position.x.toFixed(1)}, ${player.position.y.toFixed(1)}, ${player.position.z.toFixed(1)})\n`;
    if (player.dead) s += `DEAD — respawn in ${(CONFIG.player.respawnDelay - player.respawnTimer).toFixed(1)}s\n`;
    const snap = behavior.snapshot();
    for (const k of Object.keys(snap)) {
      const v = snap[k];
      if (v < 0.02) continue;
      const bars = Math.round(v * 8);
      s += `${k.padEnd(15)} [${'|'.repeat(bars)}${'·'.repeat(8 - bars)}] ${v.toFixed(2)}\n`;
    }
    debugEl.textContent = s.trim();
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);