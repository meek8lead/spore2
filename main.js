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
  uniform float uRemixFade;
  uniform float uLowHp;
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

function spawnNpcAt(pos, largeChance) {
  const useLarge = Math.random() < largeChance;
  const type = useLarge ? CONFIG.npc.types[1] : CONFIG.npc.types[0];
  return new Npc(scene, palette, pos, type);
}

function spawnNpc() {
  const chance = player.ecoLevel > CONFIG.npc.largeSpawnEco ? 0.4 : 0;
  const a = Math.random() * Math.PI * 2;
  const r = 8 + Math.random() * 4;
  const pos = new THREE.Vector3(
    player.position.x + Math.cos(a) * r,
    (Math.random() - 0.5) * 4,
    player.position.z + Math.sin(a) * r,
  );
  return spawnNpcAt(pos, chance);
}
const npcs = [spawnNpc(), spawnNpc(), spawnNpc()];

function spawnPortalNear(center) {
  if (portals.portals.length > 0) return;
  const a = Math.random() * Math.PI * 2;
  const r = CONFIG.portals.spawnDistanceMin + Math.random() * (CONFIG.portals.spawnDistanceMax - CONFIG.portals.spawnDistanceMin);
  const pos = new THREE.Vector3(center.x + Math.cos(a) * r, center.y, center.z + Math.sin(a) * r);
  portals.spawn(pos, palette);
}
spawnPortalNear(player.position);

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
let lastDebugUpdate = 0;

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
});

// ─── Remix state machine ───────────────────────────────────────────────────
let remixState = 0;
let remixTimer = 0;
let remixFade = 0;
let remixCooldown = 0;
let currentPresetName = CONFIG.remix.presets[0].name;
let pendingPreset = null;

function applyRemixPreset(preset) {
  medium.scaleMul = preset.mediumScale;
  medium.warpMul = preset.mediumWarp;
  palette.reseed(preset.paletteSeed);
  currentPresetName = preset.name;

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
      f.toxic = Math.random() < CONFIG.food.toxicChance;
      const idx = f.toxic ? 3 : Math.floor(Math.random() * palette.colors.length);
      f.mesh.material.color.copy(palette.colors[idx]);
      f.energy = 8 + 0.7 * 30;
    } else {
      f.alive = false;
      f.mesh.visible = false;
    }
  }

  for (const item of detritus.items) {
    if (item.alive) { item.alive = false; item.mesh.visible = false; }
  }

  for (let i = 0; i < npcs.length; i++) {
    const old = npcs[i];
    if (old) { scene.remove(old.mesh); old.mesh.geometry.dispose(); old.mesh.material.dispose(); }
    const a = Math.random() * Math.PI * 2;
    const r = 20 + Math.random() * 15;
    const pos = new THREE.Vector3(newPos.x + Math.cos(a) * r, (Math.random() - 0.5) * 4, newPos.z + Math.sin(a) * r);
    npcs[i] = spawnNpcAt(pos, preset.largeChance);
  }

  portals.clear();
  spawnPortalNear(newPos);
}

// ─── Main loop ─────────────────────────────────────────────────────────────
let last = performance.now();
let t = 0;
let lmbBiteCd = 0;
let dashCd = 0;
let lastMitosisCount = player.mitosisCount;

function frame(now) {
  const dt = Math.min(CONFIG.render.maxDt, (now - last) / 1000);
  last = now;
  t += dt;

  const input = player.dead ? { x: 0, y: 0 } : readInput();
  const { sample, moving } = player.update(dt, input, medium);

  audio.updateAmbient(sample.density, sample.toxicity);
  if (player.mitosisCount > lastMitosisCount) {
    audio.mitosis();
    lastMitosisCount = player.mitosisCount;
  }

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

  if (!player.dead) {
    const bite = food.tryEat(player.position, CONFIG.player.eatRange);
    if (bite.energy > 0) {
      player.feed(bite.energy);
      behavior.pulse('herbivory', CONFIG.behavior.foodPulse);
      audio.eat();
    }
    if (bite.toxicCount > 0) behavior.pulse('toxicity', CONFIG.food.toxicPulse * bite.toxicCount);
  }

  // LMB bite
  lmbBiteCd = Math.max(0, lmbBiteCd - dt);
  if (lmbDown) lmbHeldTime += dt;
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
    if (gained === 0 && lmbHeldTime > 0.8 && player.children.length > 0) {
      const ate = player.tryEatChildren(player.position, r);
      if (ate > 0) { gained += ate; behavior.pulse('predation', 0.3); }
    }
    if (gained > 0) {
      player.feed(gained);
      if (bite.energy > 0) behavior.pulse('herbivory', CONFIG.behavior.foodPulse);
      player.energy -= CONFIG.player.lmbBiteCost;
      lmbBiteCd = CONFIG.player.lmbBiteCooldown;
      audio.bite();
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
          audio.damage();
        }
      }
    }
    if (npc.type.damage > 0 && !player.dead) {
      const d = npc.position.distanceTo(player.position);
      if (d < CONFIG.colony.symbiosisRange) {
        npc.symbiosisTime += dt;
        if (npc.symbiosisTime >= CONFIG.colony.symbiosisDuration) {
          if (!npc.attached) audio.symbiosis();
          npc.attached = true;
        }
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

  // symbiont defense
  for (const npc of npcs) {
    if (!npc.alive || !npc.attached) continue;
    npc.attackCd = Math.max(0, (npc.attackCd || 0) - dt);
    if (npc.attackCd > 0) continue;
    let best = null, bestD = CONFIG.symbiontDefense.range;
    for (const h of npcs) {
      if (!h.alive || h.attached || h === npc) continue;
      const d = h.position.distanceTo(player.position);
      if (d < bestD) { bestD = d; best = h; }
    }
    if (best) {
      const c = best.kill();
      detritus.spawn(c.pos, palette, c.eco);
      npc.attackCd = CONFIG.symbiontDefense.cooldown;
      behavior.pulse('symbiosis', 0.3);
    }
  }

  // colony children defense
  for (const child of player.children) {
    if (child.cooldown > 0) continue;
    let best = null, bestD = CONFIG.colonyChild.attackRange;
    for (const npc of npcs) {
      if (!npc.alive || npc.attached) continue;
      const d = npc.position.distanceTo(child.mesh.position);
      if (d < bestD) { bestD = d; best = npc; }
    }
    if (best) {
      const c = best.kill();
      detritus.spawn(c.pos, palette, c.eco);
      player.ecoLevel += CONFIG.colonyChild.attackEcoGain;
      child.cooldown = CONFIG.colonyChild.attackCooldown;
      behavior.pulse('predation', 0.15);
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
  if (player.hp <= 0 && !player.dead) { player.kill(); audio.death(); }
  if (player.dead) {
    player.respawnTimer += dt;
    player.fade = Math.min(1, player.fade + dt * CONFIG.player.fadeSpeed);
    if (player.respawnTimer >= CONFIG.player.respawnDelay) player.respawn(findSafeSpawn());
  } else {
    player.fade = Math.max(0, player.fade - dt * CONFIG.player.fadeSpeed * 0.5);
  }

  // portals + remix
  portals.update(dt, t, player.position);
  remixCooldown = Math.max(0, remixCooldown - dt);

  if (remixState === 0 && remixCooldown <= 0 && !player.dead) {
    if (portals.tryEnter(player.position)) {
      let nextIdx = 0;
      do { nextIdx = Math.floor(Math.random() * CONFIG.remix.presets.length); }
      while (CONFIG.remix.presets[nextIdx].name === currentPresetName);
      pendingPreset = CONFIG.remix.presets[nextIdx];
      audio.portal();
      remixState = 1;
      remixTimer = 0;
    }
  }
  if (remixState === 1) {
    remixTimer += dt;
    remixFade = Math.min(1, remixTimer / CONFIG.remix.fadeDuration);
    if (remixTimer >= CONFIG.remix.fadeDuration) {
      if (pendingPreset) applyRemixPreset(pendingPreset);
      pendingPreset = null;
      remixState = 2;
      remixTimer = 0;
    }
  } else if (remixState === 2) {
    remixTimer += dt;
    remixFade = Math.max(0, 1 - remixTimer / CONFIG.remix.fadeDuration);
    if (remixTimer >= CONFIG.remix.fadeDuration) {
      remixState = 0;
      remixFade = 0;
      remixCooldown = CONFIG.portals.cooldown;
    }
  }

  updateCamera();

  background.material.uniforms.uTime.value = t;

  pipeline.setHurt(player.damageFlash);
  pipeline.setToxTint(Math.max(0, (sample.toxicity - 0.5) * 2));
  pipeline.setFade(player.fade);
  pipeline.setRemixFade(remixFade);
  const hpRatio = player.hp / CONFIG.player.maxHp;
  pipeline.setLowHp(Math.max(0, (0.3 - hpRatio) * 3));
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
    s += `children: ${player.children.length}/${CONFIG.colonyChild.maxChildren}\n`;
    s += `world:    ${currentPresetName}\n`;
    s += `audio:    ${audio.started ? 'on' : 'off'}\n`;
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