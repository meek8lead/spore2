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
    // trade-offs (A): conflicting niches cancel each other out
    const tt = CONFIG.behavior.tradeoff * dt;
    this.predation = Math.max(0, this.predation - tt * this.symbiosis);
    this.symbiosis = Math.max(0, this.symbiosis - tt * this.predation);
    const motilityPressure = this.sessility + this.armor * 0.5;
    this.motility = Math.max(0, this.motility - tt * motilityPressure);
    this.sessility = Math.max(0, this.sessility - tt * this.motility);
    this.armor = Math.max(0, this.armor - tt * this.motility * 0.5);
    this.photosynthesis = Math.max(0, this.photosynthesis - tt * this.predation * 0.5);
    this.evasion = Math.max(0, this.evasion - tt * this.armor * 0.3);
    this.armor = Math.max(0, this.armor - tt * this.evasion * 0.3);
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
    this.metamorphosisFlash = 0;
    this.lastStage = 'cell';
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

    this.scene = scene;
    this.paletteArray = paletteArray;
    this.children = [];
    this.childGeo = new THREE.IcosahedronGeometry(0.35, 1);
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

  // (A) active trade-offs: dominant behavior grants passive/active multipliers
  getEffects() {
    const b = this.behavior;
    return {
      biteMult: 1 + b.predation * 1.0,
      eatMult: 1 + b.herbivory * 0.6,
      dashCostMult: 1 - Math.min(0.6, b.motility * 0.6),
      dashCdMult: 1 - Math.min(0.5, b.motility * 0.5),
      passiveMult: 1 + b.sessility * 2.0,
      armorMult: 1 - b.armor * 0.5,
      speedMult: 1 - b.armor * 0.25,
      evasionAssist: b.evasion * 0.3,
      lightMult: 1 + b.photosynthesis * 2.0,
      darkMult: 1 - b.photosynthesis * 0.5,
      chemHpRegen: b.chemosynthesis * 2.0,
      symbiosisRate: 1 - b.predation * 0.6,
    };
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

  spawnChild() {
    if (this.children.length >= CONFIG.colonyChild.maxChildren) return null;
    const domIdx = this.behavior.dominantIndex();
    const pc = this.paletteArray[domIdx % this.paletteArray.length];
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(pc.x * 1.2, pc.y * 1.2, pc.z * 1.2) });
    const mesh = new THREE.Mesh(this.childGeo, mat);
    mesh.position.copy(this.position);
    mesh.scale.setScalar(0.7);
    this.scene.add(mesh);
    const child = { mesh, cooldown: 0 };
    this.children.push(child);
    return child;
  }
  eatChild(child) {
    const i = this.children.indexOf(child);
    if (i < 0) return 0;
    this.children.splice(i, 1);
    this.scene.remove(child.mesh);
    child.mesh.material.dispose();
    this.ecoLevel = Math.max(0, this.ecoLevel - CONFIG.colonyChild.eatEcoLoss);
    return CONFIG.colonyChild.eatEnergy;
  }
  tryEatChildren(pos, range) {
    let total = 0;
    for (let i = this.children.length - 1; i >= 0; i--) {
      if (this.children[i].mesh.position.distanceTo(pos) < range) total += this.eatChild(this.children[i]);
    }
    return total;
  }
  // (E) colony = fused tight lump; multicellular = curved tapering chain
  updateChildren(dt) {
    const cc = CONFIG.colonyChild;
    const n = this.children.length;
    if (n === 0) return;
    const stage = this.stage;
    const velDir = this.velocity.lengthSq() > 0.01
      ? this.velocity.clone().normalize()
      : new THREE.Vector3(0, 0, -1);
    const perp = new THREE.Vector3(-velDir.z, 0, velDir.x).normalize();
    for (let i = 0; i < n; i++) {
      const c = this.children[i];
      c.cooldown = Math.max(0, c.cooldown - dt);
      let target, scale;
      if (stage === 'multicellular') {
        // tree/chain: curved spine with taper
        const back = -(i + 1) * cc.multicellularSpacing;
        const wave = Math.sin(this.time * 2.0 + i * 0.8) * 0.22;
        const lateral = wave + (i % 2 === 0 ? 0.1 : -0.1);
        target = this.position.clone()
          .addScaledVector(velDir, back)
          .addScaledVector(perp, lateral);
        const baseSc = cc.multicellularScale[i] || 0.6;
        let sizeMult = 1;
        if (i === 0 && this.behavior.predation > 0.3) sizeMult = 1.5;
        if (i === n - 1 && this.behavior.motility > 0.3) sizeMult = 1.4;
        const taper = 1 - i * 0.1;
        scale = baseSc * 0.6 * Math.sqrt(this.mass) * sizeMult * taper;
      } else {
        // colony: tight orbit — looks fused with core
        const a = (i / Math.max(1, n)) * Math.PI * 2 + this.time * 0.5;
        target = this.position.clone().add(new THREE.Vector3(
          Math.cos(a) * cc.orbitRadius,
          Math.sin(a * 0.9) * 0.12,
          Math.sin(a) * cc.orbitRadius,
        ));
        scale = 0.55 * Math.sqrt(this.mass) * (0.9 + (i % 3) * 0.08);
      }
      c.mesh.position.lerp(target, 1 - Math.exp(-cc.driftLerp * dt));
      c.mesh.scale.setScalar(scale);
      c.mesh.rotation.x += dt * 1.0;
      c.mesh.rotation.y += dt * 1.4;
    }
  }

  update(dt, input, medium) {
    this.time += dt;
    const sample = medium.sample(this.position.x, this.position.y, this.position.z);
    const effects = this.getEffects();

    this.invulnTimer = Math.max(0, this.invulnTimer - dt);
    this.damageFlash = Math.max(0, this.damageFlash - CONFIG.player.damageFlashDecay * dt);
    this.mitosisFlash = Math.max(0, this.mitosisFlash - dt * 2.5);
    this.metamorphosisFlash = Math.max(0, this.metamorphosisFlash - dt * 1.2);

    if (!this.dead && this.time - this.lastDamageTime > 3) {
      const regen = CONFIG.player.hpRegen + effects.chemHpRegen * sample.chemEnergy;
      this.hp = Math.min(CONFIG.player.maxHp, this.hp + regen * dt);
    }

    if (this.dead) {
      this.material.uniforms.uTime.value = this.time;
      this.material.uniforms.uHurt.value = 0;
      this.updateChildren(dt);
      return { sample, moving: false };
    }

    const viscosity = sample.viscosity;
    const accel = CONFIG.player.accel / (0.4 + viscosity * 1.8);
    this.velocity.x += input.x * accel * dt;
    this.velocity.z += input.y * accel * dt;

    const drag = Math.exp(-CONFIG.player.drag * (0.4 + viscosity) * dt);
    this.velocity.multiplyScalar(drag);

    const sp = this.velocity.length();
    const maxSp = CONFIG.player.maxSpeed * effects.speedMult;
    if (sp > maxSp) this.velocity.multiplyScalar(maxSp / sp);
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
      if (this.stage !== 'cell') this.spawnChild();
    }

    // stage metamorphosis event
    const nowStage = this.stage;
    if (nowStage !== this.lastStage) {
      this.metamorphosisFlash = 1;
      this.lastStage = nowStage;
    }

    this.mesh.scale.setScalar(Math.sqrt(this.mass));
    this.mesh.position.copy(this.position);

    this.material.uniforms.uSpikes.value = this.behavior.predation * 0.7 + this.behavior.armor * 0.4;
    this.material.uniforms.uFuzz.value = this.behavior.chemosynthesis * 1.0 + this.behavior.symbiosis * 0.6;
    this.material.uniforms.uTint.value = this.behavior.dominantIndex() / 11;
    this.material.uniforms.uFlash.value = Math.max(this.mitosisFlash, this.metamorphosisFlash * 0.85);
    this.material.uniforms.uHurt.value = this.damageFlash;
    this.material.uniforms.uColony.value = this.colonyFactor;

    const speedRatio = Math.min(1, this.velocity.length() / maxSp);
    this.material.uniforms.uStretch.value = this.behavior.motility * 0.35 * speedRatio;
    if (this.velocity.lengthSq() > 0.001) {
      this.material.uniforms.uStretchDir.value.copy(this.velocity).normalize();
    }

    this.material.uniforms.uTime.value = this.time;
    this.material.uniforms.uEnergy.value = energyRatio;

    this.updateChildren(dt);
    return { sample, moving, effects };
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
    base += vec3(vSpike * 1.3);
    base *= mix(0.4, 1.05, uEnergy);
    base = mix(base * 0.5, base, 1.0 - rim);
    base += vec3(0.18) * rim * (0.6 + 0.4 * sin(uTime * 1.5));
    base += vec3(1.0, 0.95, 0.7) * uFlash * 0.75;
    base = mix(base, vec3(0.55, 0.06, 0.06), uHurt * 0.7);
    gl_FragColor = vec4(base, 1.0);
  }
`;