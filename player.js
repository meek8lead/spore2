import * as THREE from 'three';
import { CONFIG } from './config.js';

export const BEHAVIOR_FIELDS = [
  'predation', 'herbivory', 'scavenging', 'symbiosis', 'motility',
  'sessility', 'armor', 'toxicity', 'evasion', 'photosynthesis', 'chemosynthesis',
];

export class BehaviorProfile {
  constructor(rate = 0.15, pulseDecay = 2.5) {
    this.rate = rate;
    this.pulseDecay = pulseDecay;
    this.pulses = {};
    for (const f of BEHAVIOR_FIELDS) { this[f] = 0; this.pulses[f] = 0; }
  }
  pulse(field, amount = 0.6) {
    this.pulses[field] = Math.min(1, this.pulses[field] + amount);
  }
  tick(dt, state) {
    const k = 1 - Math.exp(-this.rate * dt);
    const decay = Math.exp(-this.pulseDecay * dt);
    for (const f of BEHAVIOR_FIELDS) {
      this.pulses[f] *= decay;
      const target = Math.min(1, (state[f] ? 1 : 0) + this.pulses[f]);
      this[f] += (target - this[f]) * k;
    }
  }
  dominant() {
    let best = 'motility', bestV = -1;
    for (const f of BEHAVIOR_FIELDS) if (this[f] > bestV) { bestV = this[f]; best = f; }
    return best;
  }
  dominantIndex() { return BEHAVIOR_FIELDS.indexOf(this.dominant()); }
  snapshot() {
    const out = {};
    for (const f of BEHAVIOR_FIELDS) out[f] = this[f];
    return out;
  }
}

export class Player {
  constructor(scene, paletteArray, behavior) {
    this.behavior = behavior;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.energy = CONFIG.player.baseEnergy;
    this.hp = CONFIG.player.maxHp;
    this.ecoLevel = 0;
    this.mass = CONFIG.player.massStart;
    this.mitosisCount = 0;
    this.mitosisFlash = 0;
    this.mitosisCooldown = 0;
    this.damageFlash = 0;
    this.invulnTimer = 0;
    this.lastDamageTime = -10;
    this.time = 0;
    this.dead = false;
    this.respawnTimer = 0;
    this.fade = 0;

    const geo = new THREE.IcosahedronGeometry(0.7, 3);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uEnergy: { value: 1 },
        uSpikes: { value: 0 },
        uFuzz: { value: 0 },
        uTint: { value: 0 },
        uFlash: { value: 0 },
        uHurt: { value: 0 },
        uColony: { value: 0 },
        uStretch: { value: 0 },
        uStretchDir: { value: new THREE.Vector3(1, 0, 0) },
        uPalette: { value: paletteArray },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    scene.add(this.mesh);
  }

  get stage() {
    if (this.ecoLevel >= CONFIG.stages.multicellularThreshold) return 'multicellular';
    if (this.ecoLevel >= CONFIG.stages.colonyThreshold) return 'colony';
    return 'cell';
  }
  get colonyFactor() {
    const t = CONFIG.stages.colonyThreshold;
    const m = CONFIG.stages.multicellularThreshold;
    return Math.max(0, Math.min(1, (this.ecoLevel - t) / (m - t)));
  }

  takeDamage(amount, now) {
    if (this.invulnTimer > 0 || this.dead) return false;
    this.hp = Math.max(0, this.hp - amount);
    this.damageFlash = 1;
    this.invulnTimer = CONFIG.npc.contactDamageCooldown;
    this.lastDamageTime = now;
    return true;
  }

  kill() {
    if (this.dead) return;
    this.dead = true;
    this.hp = 0;
    this.respawnTimer = 0;
  }

  respawn(p) {
    this.dead = false;
    this.hp = CONFIG.player.maxHp;
    this.energy = CONFIG.player.baseEnergy * CONFIG.player.respawnEnergyRatio;
    this.invulnTimer = CONFIG.player.respawnInvuln;
    this.position.copy(p);
    this.velocity.set(0, 0, 0);
    this.mass = Math.max(CONFIG.player.massMin, this.mass * 0.7);
    this.fade = 1;
  }

  update(dt, input, medium) {
    this.time += dt;
    const sample = medium.sample(this.position.x, this.position.y, this.position.z);

    this.invulnTimer = Math.max(0, this.invulnTimer - dt);
    this.damageFlash = Math.max(0, this.damageFlash - CONFIG.player.damageFlashDecay * dt);
    this.mitosisFlash = Math.max(0, this.mitosisFlash - dt * 2.5);

    if (!this.dead && this.time - this.lastDamageTime > 3) {
      this.hp = Math.min(CONFIG.player.maxHp, this.hp + CONFIG.player.hpRegen * dt);
    }

    if (this.dead) {
      this.material.uniforms.uTime.value = this.time;
      this.material.uniforms.uHurt.value = 0;
      return { sample, moving: false };
    }

    const viscosity = sample.viscosity;
    const accel = CONFIG.player.accel / (0.4 + viscosity * 1.8);
    this.velocity.x += input.x * accel * dt;
    this.velocity.z += input.y * accel * dt;

    const drag = Math.exp(-CONFIG.player.drag * (0.4 + viscosity) * dt);
    this.velocity.multiplyScalar(drag);

    const sp = this.velocity.length();
    if (sp > CONFIG.player.maxSpeed) this.velocity.multiplyScalar(CONFIG.player.maxSpeed / sp);
    this.position.addScaledVector(this.velocity, dt);

    const moving = sp > 0.15;
    const drain = moving ? CONFIG.player.drainMove : CONFIG.player.drainIdle;
    this.energy = Math.max(0, this.energy - drain * dt);

    const energyRatio = this.energy / CONFIG.player.baseEnergy;
    if (energyRatio > 0.6) this.mass = Math.min(CONFIG.player.massMax, this.mass + CONFIG.player.massGrowth * dt);
    else if (energyRatio < 0.2) this.mass = Math.max(CONFIG.player.massMin, this.mass - CONFIG.player.massDecay * dt);

    this.mitosisCooldown = Math.max(0, this.mitosisCooldown - dt);
    const threshold = 2.0 + this.ecoLevel * 0.4;
    if (this.mitosisCooldown <= 0 && this.mass >= threshold && energyRatio > 0.85) {
      this.mass *= 0.5;
      this.energy *= 0.5;
      this.ecoLevel += CONFIG.player.ecoLevelPerMitosis;
      this.mitosisCount++;
      this.mitosisFlash = 1;
      this.mitosisCooldown = CONFIG.player.mitosisCooldown;
    }

    this.mesh.scale.setScalar(Math.sqrt(this.mass));
    this.mesh.position.copy(this.position);

    this.material.uniforms.uSpikes.value = this.behavior.predation * 0.7 + this.behavior.armor * 0.4;
    this.material.uniforms.uFuzz.value = this.behavior.chemosynthesis * 1.0 + this.behavior.symbiosis * 0.6;
    this.material.uniforms.uTint.value = this.behavior.dominantIndex() / 11;
    this.material.uniforms.uFlash.value = this.mitosisFlash;
    this.material.uniforms.uHurt.value = this.damageFlash;
    this.material.uniforms.uColony.value = this.colonyFactor;

    const speedRatio = Math.min(1, this.velocity.length() / CONFIG.player.maxSpeed);
    this.material.uniforms.uStretch.value = this.behavior.motility * 0.35 * speedRatio;
    if (this.velocity.lengthSq() > 0.001) {
      this.material.uniforms.uStretchDir.value.copy(this.velocity).normalize();
    }

    this.material.uniforms.uTime.value = this.time;
    this.material.uniforms.uEnergy.value = energyRatio;

    return { sample, moving };
  }

  feed(amount) {
    this.energy = Math.min(CONFIG.player.baseEnergy, this.energy + amount);
  }
}

const VERT = /* glsl */ `
  uniform float uTime;
  uniform float uSpikes;
  uniform float uFuzz;
  uniform float uStretch;
  uniform float uColony;
  uniform vec3 uStretchDir;
  varying vec3 vN;
  varying vec3 vView;
  varying float vDisp;
  varying float vSpike;
  varying float vColony;

  float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898,78.233,45.164))) * 43758.5453); }
  float noise(vec3 p) {
    vec3 i = floor(p); vec3 f = fract(p);
    f = f*f*(3.0-2.0*f);
    return mix(mix(mix(hash(i), hash(i+vec3(1,0,0)), f.x),
                   mix(hash(i+vec3(0,1,0)), hash(i+vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i+vec3(0,0,1)), hash(i+vec3(1,0,1)), f.x),
                   mix(hash(i+vec3(0,1,1)), hash(i+vec3(1,1,1)), f.x), f.y), f.z);
  }

  void main() {
    vec3 p = position;
    vec3 n = normalize(position);
    float w1 = noise(p * 2.0 + vec3(uTime * 0.5, uTime * 0.3, uTime * 0.2));
    float w2 = noise(p * 4.5 - vec3(uTime * 0.4));
    p += n * ((w1 - 0.5) * 0.16 + (w2 - 0.5) * 0.09);
    vDisp = (w1 - 0.5) * 0.16 + (w2 - 0.5) * 0.09;

    float sN = noise(p * 5.0 + uTime * 0.2);
    float spike = pow(max(0.0, sN), 4.0) * uSpikes;
    p += n * spike * 0.4;
    vSpike = spike;

    float fN = noise(p * 14.0 + uTime * 0.7);
    p += n * (fN - 0.5) * uFuzz * 0.06;

    float cellN = noise(p * 3.2 + vec3(uTime * 0.12));
    float cellLump = smoothstep(0.35, 0.72, cellN);
    p += n * cellLump * uColony * 0.28;
    vColony = cellLump * uColony;

    float proj = dot(p, uStretchDir);
    p += uStretchDir * proj * uStretch;

    vN = normalize(normalMatrix * normal);
    vView = (modelViewMatrix * vec4(p, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vN;
  varying vec3 vView;
  varying float vDisp;
  varying float vSpike;
  varying float vColony;
  uniform float uTime;
  uniform float uEnergy;
  uniform float uTint;
  uniform float uFlash;
  uniform float uHurt;
  uniform float uColony;
  uniform vec3 uPalette[16];

  void main() {
    vec3 n = normalize(vN);
    vec3 v = normalize(-vView);
    float rim = pow(1.0 - max(dot(n, v), 0.0), 2.0);
    float idx = clamp((vDisp * 4.0 + 0.5) * 16.0, 0.0, 15.0);
    vec3 base = uPalette[int(idx)];
    float tintIdx = clamp(fract(uTint + vDisp * 0.5) * 16.0, 0.0, 15.0);
    base = mix(base, uPalette[int(tintIdx)], 0.35);
    base = mix(base, base * (0.5 + 0.5 * vColony), uColony * 0.6);
    base += vec3(vSpike * 1.5);
    base *= mix(0.35, 1.1, uEnergy);
    base = mix(base * 0.4, base, 1.0 - rim);
    base += vec3(0.25) * rim * (0.6 + 0.4 * sin(uTime * 4.0));
    base += vec3(1.0, 0.9, 0.6) * uFlash * 0.8;
    base = mix(base, vec3(0.6, 0.05, 0.05), uHurt * 0.7);
    gl_FragColor = vec4(base, 1.0);
  }
`;