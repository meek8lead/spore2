import * as THREE from 'three';
import { CONFIG, mulberry32, vnoise3 } from './config.js';

// ─── Medium ────────────────────────────────────────────────────────────────
export class Medium {
  constructor() {
    this.scaleMul = 1;
    this.warpMul = 1;
  }
  sample(x, y, z) {
    const s = CONFIG.medium.scale * this.scaleMul;
    const w = CONFIG.medium.warp * this.warpMul;
    const wx = (vnoise3(x * s * 2, y * s * 2, z * s * 2, 1) - 0.5) * w * 2;
    const wy = (vnoise3(x * s * 2, y * s * 2, z * s * 2, 2) - 0.5) * w * 2;
    const wz = (vnoise3(x * s * 2, y * s * 2, z * s * 2, 3) - 0.5) * w * 2;
    const a = vnoise3(x * s + wx, y * s + wy, z * s + wz, 4);
    const b = vnoise3(x * s + wx, y * s + wy, z * s + wz, 5);
    const c = vnoise3(x * s + wx, y * s + wy, z * s + wz, 6);
    const tox = Math.max(0, (vnoise3(x * s * 0.7, y * s * 0.7, z * s * 0.7, 7) - 0.55) * 2.5);
    return {
      density: a,
      viscosity: b * 0.7 + 0.15,
      luminosity: c,
      chemEnergy: Math.max(0, a * b),
      toxicity: Math.min(1, tox),
    };
  }
  ecoLevel(x, y, z) {
    const s = CONFIG.world.ecoNoiseScale;
    return CONFIG.world.ecoTrueBaseline + vnoise3(x * s, y * s, z * s, 8) * CONFIG.world.ecoTrueAmp;
  }
}

// ─── Ecosystem helpers ─────────────────────────────────────────────────────
export function ecoLevelAt(pos, playerPos, playerEco, medium, rubberOffset = 0) {
  const trueLvl = medium.ecoLevel(pos.x, pos.y, pos.z);
  const d = pos.distanceTo(playerPos);
  const r = CONFIG.world.ecoRubberRadius;
  const w = Math.exp(-(d * d) / (r * r));
  const blended = trueLvl + w * (playerEco - trueLvl);
  return Math.max(0, Math.min(1.5, blended + w * rubberOffset));
}

export class Rubberband {
  constructor() { this.offset = 0; this.lowT = 0; this.highT = 0; }
  update(dt, energyRatio, tookDamage) {
    const c = CONFIG.rubberband;
    if (energyRatio < c.lowEnergyThreshold && !tookDamage) this.lowT += dt; else this.lowT = 0;
    if (energyRatio > c.highEnergyThreshold && !tookDamage) this.highT += dt; else this.highT = 0;
    let target = 0;
    if (this.lowT > c.lowEnergyDuration) target = c.foodDensityBoost;
    else if (this.highT > c.highEnergyDuration) target = c.foodDensityReduce;
    this.offset += (target - this.offset) * (1 - Math.exp(-c.smoothing * dt));
  }
}

export class ToxicityZone {
  damageAt(sample) {
    if (sample.toxicity < CONFIG.toxicity.threshold) return 0;
    return (sample.toxicity - CONFIG.toxicity.threshold) * CONFIG.toxicity.dotPerSec;
  }
}

// ─── Palette ───────────────────────────────────────────────────────────────
export class Palette {
  constructor(seed = 42) {
    this.colors = [];
    this.uniformArray = [];
    this.baseHSL = [];
    this.t = 0;
    this._build(seed);
    this.refresh();
  }
  _build(seed) {
    const rng = mulberry32(seed);
    const baseHue = rng() * 360;
    const n = CONFIG.palette.size;
    this.baseHSL = [];
    for (let i = 0; i < n; i++) {
      const h = ((baseHue + (i * 360) / n + rng() * 20) % 360) / 360;
      const s = 0.22 + rng() * 0.32;
      const l = 0.34 + rng() * 0.28;
      this.baseHSL.push({ h, s, l });
      if (!this.colors[i]) {
        this.colors[i] = new THREE.Color();
        this.uniformArray[i] = new THREE.Vector3();
      }
    }
  }
  update(dt) { this.t += dt; this.refresh(); }
  reseed(seed) { this._build(seed); this.t = 0; this.refresh(); }
  refresh() {
    const shift = this.t * CONFIG.palette.cycleSpeed;
    const satMul = CONFIG.palette.saturationMul;
    for (let i = 0; i < this.baseHSL.length; i++) {
      const b = this.baseHSL[i];
      const h = (b.h + shift * 0.03 + 1) % 1;
      const l = Math.max(0.15, Math.min(0.82, b.l + Math.sin(this.t * 0.15 + i * 0.7) * 0.03));
      const s = b.s * satMul;
      const c = this.colors[i].setHSL(h, s, l);
      this.uniformArray[i].set(c.r, c.g, c.b);
    }
  }
}

// ─── Background ────────────────────────────────────────────────────────────
export function createBackground(palette) {
  const geo = new THREE.SphereGeometry(200, 32, 16);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPalette: { value: palette.uniformArray } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vDir;
      uniform float uTime;
      uniform vec3 uPalette[16];

      vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
      vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
      vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
      vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
      float snoise(vec3 v){
        const vec2 C=vec2(1.0/6.0,1.0/3.0);const vec4 D=vec4(0.0,0.5,1.0,2.0);
        vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
        vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.0-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
        vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;i=mod289(i);
        vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
        float n_=0.142857142857;vec3 ns=n_*D.wyz-D.xzx;
        vec4 j=p-49.0*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.0*x_);
        vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.0-abs(x)-abs(y);
        vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
        vec4 s0=floor(b0)*2.0+1.0;vec4 s1=floor(b1)*2.0+1.0;vec4 sh=-step(h,vec4(0.0));
        vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
        vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
        vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
        p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
        vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);m=m*m;
        return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
      }
      vec3 paletteLookup(float t){t=clamp(t,0.0,0.999);return uPalette[int(t*16.0)];}

      void main(){
        vec3 d=normalize(vDir);
        float t=uTime*0.02;
        vec3 w=vec3(snoise(d*1.5+t),snoise(d*1.5+t+10.0),snoise(d*1.5+t+20.0))*0.45;
        float a=snoise(d*2.5+w+t*0.15)*0.5+0.5;
        float b=snoise(d*5.0+w*1.4-t*0.1)*0.5+0.5;
        float v=mix(a,b,0.35);
        vec3 col=paletteLookup(v);
        col*=mix(0.45,1.0,d.y*0.5+0.5);
        float horizon=smoothstep(0.03,0.0,abs(d.y-0.02));
        col=mix(col,col*1.15,horizon*0.3);
        gl_FragColor=vec4(col,1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -1;
  return mesh;
}

// ─── FoodField (3 типа: organic / mineral / toxic) ────────────────────────
export class FoodField {
  constructor(scene, palette, seed = 99) {
    this.rng = mulberry32(seed);
    this.foods = [];
    this.group = new THREE.Group();
    this.geo = new THREE.IcosahedronGeometry(0.28, 0);
    this.geoMineral = new THREE.OctahedronGeometry(0.22, 0);
    scene.add(this.group);
    for (let i = 0; i < CONFIG.world.foodCount; i++) this.spawnAround(new THREE.Vector3(), palette);
  }
  _rollType() {
    const roll = Math.random();
    if (roll < CONFIG.food.toxicChance) return 'toxic';
    if (roll < CONFIG.food.toxicChance + CONFIG.food.mineralChance) return 'mineral';
    return 'organic';
  }
  _colorFor(type, palette) {
    if (type === 'toxic') return palette.colors[3].clone().multiplyScalar(0.3);
    if (type === 'mineral') return new THREE.Color(0.92, 0.88, 0.35);
    return palette.colors[Math.floor(this.rng() * palette.colors.length)].clone();
  }
  spawnAround(center, palette) {
    const angle = this.rng() * Math.PI * 2;
    const radius = 3 + this.rng() * CONFIG.world.foodSpawnRadius;
    const pos = new THREE.Vector3(
      center.x + Math.cos(angle) * radius,
      center.y + (this.rng() - 0.5) * 8,
      center.z + Math.sin(angle) * radius,
    );
    this._createFood(pos, palette);
  }
  _createFood(pos, palette, ecoLevel = 0.5) {
    const type = this._rollType();
    const mat = new THREE.MeshBasicMaterial({ color: this._colorFor(type, palette) });
    const geo = type === 'mineral' ? this.geoMineral : this.geo;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos);
    this.group.add(mesh);
    this.foods.push({ mesh, energy: 8 + ecoLevel * 30, alive: true, type });
  }
  seedAround(center, count, radius) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * radius;
      const p = new THREE.Vector3(
        center.x + Math.cos(a) * r,
        center.y + (Math.random() - 0.5) * 0.6,
        center.z + Math.sin(a) * r,
      );
      const f = this.foods[i];
      f.mesh.position.copy(p);
      f.alive = true;
      f.mesh.visible = true;
    }
  }
  update(t) {
    for (const f of this.foods) {
      if (!f.alive) continue;
      f.mesh.rotation.x += 0.012;
      f.mesh.rotation.y += 0.015;
      f.mesh.position.y += Math.sin(t * 1.7 + f.mesh.position.x * 0.8) * 0.002;
    }
  }
  tryEat(pos, range, includeMineral = false) {
    let energy = 0;
    let toxicCount = 0;
    let mineralCount = 0;
    for (const f of this.foods) {
      if (!f.alive) continue;
      if (f.mesh.position.distanceTo(pos) >= range) continue;
      if (f.type === 'mineral' && !includeMineral) continue;
      f.alive = false;
      f.mesh.visible = false;
      if (f.type === 'toxic') { energy += f.energy * CONFIG.food.toxicEnergyMult; toxicCount++; }
      else if (f.type === 'mineral') { mineralCount++; }
      else energy += f.energy;
    }
    return { energy, toxicCount, mineralCount };
  }
  // Для экосистемы NPC: small едят органику
  tryEatForNpc(pos, range) {
    for (const f of this.foods) {
      if (!f.alive) continue;
      if (f.type !== 'organic') continue;
      if (f.mesh.position.distanceTo(pos) >= range) continue;
      f.alive = false;
      f.mesh.visible = false;
      return f.energy;
    }
    return 0;
  }
  respawnDead(playerPos, palette, playerEcoLevel, medium, rubberOffset) {
    for (const f of this.foods) {
      if (f.alive) continue;
      const angle = this.rng() * Math.PI * 2;
      const radius = 6 + this.rng() * CONFIG.world.foodSpawnRadius;
      const pos = new THREE.Vector3(
        playerPos.x + Math.cos(angle) * radius,
        playerPos.y + (this.rng() - 0.5) * 8,
        playerPos.z + Math.sin(angle) * radius,
      );
      const lvl = ecoLevelAt(pos, playerPos, playerEcoLevel, medium, rubberOffset);
      if (lvl < 0.15) continue;
      f.mesh.position.copy(pos);
      f.alive = true;
      f.mesh.visible = true;
      f.energy = 8 + lvl * 30;
      f.type = this._rollType();
      f.mesh.material.color.copy(this._colorFor(f.type, palette));
    }
  }
}

// ─── Npc with ecosystem (C) ───────────────────────────────────────────────
export class Npc {
  constructor(scene, palette, spawnPos, type) {
    this.type = type;
    this.home = spawnPos.clone();
    this.position = spawnPos.clone();
    this.velocity = new THREE.Vector3();
    this.alive = true;
    this.attached = false;
    this.symbiosisTime = 0;
    this.phase = Math.random() * 100;
    this.hunger = Math.random() * 0.3;
    this.hp = 100;
    this.eatCooldown = 0;
    this.eatenCount = 0;
    this.reproCooldown = 0;
    this.reproReady = false;
    this.deadTimer = 0;

    const geo = new THREE.IcosahedronGeometry(type.size, 1);
    const colorIdx = type.damage > 0 ? 5 : Math.floor(Math.random() * palette.colors.length);
    this.baseColor = palette.colors[colorIdx].clone();
    this.material = new THREE.MeshBasicMaterial({ color: this.baseColor.clone() });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.position.copy(this.position);
    scene.add(this.mesh);
    this.scene = scene;
  }

  _rescale(size) {
    this.mesh.geometry.dispose();
    this.mesh.geometry = new THREE.IcosahedronGeometry(size, 1);
  }

  respawn(pos, type) {
    this.type = type;
    this._rescale(type.size);
    this.position.copy(pos);
    this.home.copy(pos);
    this.mesh.position.copy(pos);
    this.alive = true;
    this.mesh.visible = true;
    this.hunger = 0.3;
    this.eatCooldown = 0;
    this.eatenCount = 0;
    this.hp = 100;
    this.reproCooldown = 0;
    this.reproReady = false;
    this.attached = false;
    this.symbiosisTime = 0;
    this.velocity.set(0, 0, 0);
    const colorIdx = type.damage > 0 ? 5 : Math.floor(Math.random() * 16);
    // re-color (approximate; palette will override anyway)
    this.material.color.copy(this.baseColor);
  }

  update(dt, playerPos, ctx) {
    if (!this.alive) { this.deadTimer += dt; return; }
    this.phase += dt;
    this.eatCooldown = Math.max(0, this.eatCooldown - dt);
    this.reproCooldown = Math.max(0, this.reproCooldown - dt);

    // голод растёт
    this.hunger = Math.min(1, this.hunger + CONFIG.ecosystem.npcHungerRate * dt);

    // ── Питание ──
    if (this.eatCooldown <= 0 && ctx) {
      if (this.type.name === 'small' && ctx.food) {
        const energy = ctx.food.tryEatForNpc(this.position, CONFIG.ecosystem.smallFoodRange);
        if (energy > 0) {
          this.hunger = Math.max(0, this.hunger - 0.4);
          this.eatenCount++;
          this.eatCooldown = CONFIG.ecosystem.npcEatCooldown;
          if (this.eatenCount >= CONFIG.ecosystem.smallReproCount && this.reproCooldown <= 0) {
            this.reproReady = true;
            this.eatenCount = 0;
            this.reproCooldown = CONFIG.ecosystem.reproCooldown;
          }
        }
      }
      if (this.type.name === 'large' && ctx.npcs) {
        for (const other of ctx.npcs) {
          if (other === this || !other.alive) continue;
          if (other.type.name !== 'small') continue;
          if (this.position.distanceTo(other.position) < CONFIG.ecosystem.largeEatRange) {
            const info = other.kill();
            this.hunger = Math.max(0, this.hunger - 0.6);
            this.eatenCount++;
            this.eatCooldown = CONFIG.ecosystem.npcEatCooldown;
            if (ctx.onNpcKilled) ctx.onNpcKilled(other, info);
            if (this.eatenCount >= CONFIG.ecosystem.largeReproCount && this.reproCooldown <= 0) {
              this.reproReady = true;
              this.eatenCount = 0;
              this.reproCooldown = CONFIG.ecosystem.reproCooldown;
            }
            break;
          }
        }
      }
    }

    // ── Голодная смерть ──
    if (this.hunger >= 1.0) {
      this.hp -= CONFIG.ecosystem.npcStarveDamage * dt;
      if (this.hp <= 0 && this.alive) {
        const info = this.kill();
        if (ctx && ctx.onNpcKilled) ctx.onNpcKilled(this, info);
      }
      return;
    }

    // ── Движение (поведение — как раньше) ──
    const t = this.type;
    let target, speed;
    if (t.damage > 0) {
      const d = this.position.distanceTo(playerPos);
      if (d < CONFIG.npc.patrolAggroRange && !this.attached) {
        target = playerPos.clone();
        speed = CONFIG.npc.patrolChaseSpeed;
      } else {
        const wander = new THREE.Vector3(
          Math.sin(this.phase * 0.7),
          Math.cos(this.phase * 0.5) * 0.5,
          Math.cos(this.phase * 0.9),
        ).multiplyScalar(t.wanderRadius);
        target = this.home.clone().add(wander);
        speed = CONFIG.npc.patrolSpeed;
      }
    } else {
      const wander = new THREE.Vector3(
        Math.sin(this.phase * 0.7),
        Math.cos(this.phase * 0.5) * 0.5,
        Math.cos(this.phase * 0.9),
      ).multiplyScalar(t.wanderRadius);
      target = this.home.clone().add(wander);
      speed = t.wanderSpeed;
      const toPlayer = this.position.clone().sub(playerPos);
      if (toPlayer.length() < t.fleeRange) {
        target = this.position.clone().add(toPlayer.normalize().multiplyScalar(3));
      }
      // small flee hungry large
      if (this.hunger < 0.7) {
        for (const other of (ctx?.npcs || [])) {
          if (other === this || !other.alive) continue;
          if (other.type.damage > 0 && this.position.distanceTo(other.position) < 3.5) {
            const away = this.position.clone().sub(other.position).normalize().multiplyScalar(3);
            target = this.position.clone().add(away);
            speed = t.fleeStrength;
            break;
          }
        }
      }
    }

    const desired = target.sub(this.position);
    if (desired.lengthSq() > 0.0001) desired.normalize().multiplyScalar(speed);
    this.velocity.lerp(desired, 1 - Math.exp(-3 * dt));
    this.position.addScaledVector(this.velocity, dt);
    this.mesh.position.copy(this.position);
    this.mesh.rotation.x += dt * 0.8;
    this.mesh.rotation.y += dt * 1.1;

    // визуальные сигналы голода: тусклее и меньше когда голоден
    const health = 1 - this.hunger * 0.6;
    if (this.attached) this.material.color.copy(this.baseColor).multiplyScalar(1.4 * health);
    else this.material.color.copy(this.baseColor).multiplyScalar(0.5 + health * 0.6);
  }

  tryHit() {
    if (this.attached) return false;
    if (this.type.damage <= 0) return false;
    return true;
  }
  kill() {
    if (!this.alive) return { pos: this.position.clone(), eco: 0 };
    this.alive = false;
    this.mesh.visible = false;
    return { pos: this.position.clone(), eco: this.type.corpseEco };
  }
}

// ─── Detritus ──────────────────────────────────────────────────────────────
export class DetritusField {
  constructor(scene, palette, maxItems = CONFIG.detritus.maxItems) {
    this.items = [];
    this.group = new THREE.Group();
    this.geo = new THREE.IcosahedronGeometry(0.18, 0);
    scene.add(this.group);
    for (let i = 0; i < maxItems; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: palette.colors[0].clone().multiplyScalar(0.4) });
      const mesh = new THREE.Mesh(this.geo, mat);
      mesh.visible = false;
      this.group.add(mesh);
      this.items.push({ mesh, ttl: 0, alive: false, energy: CONFIG.detritus.energy });
    }
  }
  spawn(pos, palette, ecoLevel) {
    const item = this.items.find((i) => !i.alive);
    if (!item) return;
    item.alive = true;
    item.ttl = CONFIG.detritus.lifetime;
    item.energy = CONFIG.detritus.energy + ecoLevel * 8;
    item.mesh.visible = true;
    item.mesh.position.copy(pos);
    const idx = Math.floor(Math.random() * palette.colors.length);
    item.mesh.material.color.copy(palette.colors[idx]).multiplyScalar(0.4);
  }
  update(dt) {
    for (const item of this.items) {
      if (!item.alive) continue;
      item.ttl -= dt;
      item.mesh.rotation.x += dt * 0.4;
      if (item.ttl <= 0) { item.alive = false; item.mesh.visible = false; }
    }
  }
  tryPickup(pos, range) {
    let gained = 0;
    for (const item of this.items) {
      if (!item.alive) continue;
      if (item.mesh.position.distanceTo(pos) < range) {
        item.alive = false;
        item.mesh.visible = false;
        gained += item.energy;
      }
    }
    return gained;
  }
}

// ─── PortalField with presets (D) ─────────────────────────────────────────
export class PortalField {
  constructor(scene, palette) {
    this.scene = scene;
    this.portals = [];
  }
  spawnWithPreset(pos, palette, presetName = 'BASE') {
    const preset = CONFIG.portalPresets[presetName] || CONFIG.portalPresets.BASE;
    const color = new THREE.Color(preset.color[0], preset.color[1], preset.color[2]);
    const geo = new THREE.TorusGeometry(preset.radius, preset.tube, 10, 32);
    const mat = new THREE.MeshBasicMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos);
    mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
    this.scene.add(mesh);
    this.portals.push({
      mesh, geo, phase: Math.random() * 100,
      baseColor: color.clone(), preset: presetName, presetData: preset,
    });
  }
  // обратная совместимость
  spawn(pos, palette) { this.spawnWithPreset(pos, palette, 'BASE'); }

  update(dt, t, playerPos) {
    for (const p of this.portals) {
      p.phase += dt;
      const d = p.mesh.position.distanceTo(playerPos);
      const near = Math.max(0, 1 - d / CONFIG.portals.glowRadius);
      const glowBase = p.presetData.glow;
      const glow = glowBase * (0.8 + 0.4 * Math.sin(p.phase * 2 + t)) + near * 1.4;
      p.mesh.scale.setScalar(1 + near * 0.6);
      p.mesh.material.color.copy(p.baseColor).multiplyScalar(glow);
      p.mesh.rotation.z += dt * p.presetData.spin;
      p.mesh.rotation.x += dt * p.presetData.spin * 0.5;
    }
  }
  closestDistance(playerPos) {
    let d = Infinity;
    for (const p of this.portals) {
      const dist = p.mesh.position.distanceTo(playerPos);
      if (dist < d) d = dist;
    }
    return d;
  }
  tryEnter(pos) {
    for (const p of this.portals) {
      if (p.mesh.position.distanceTo(pos) < CONFIG.portals.triggerRadius) return p;
    }
    return null;
  }
  clear() {
    for (const p of this.portals) {
      this.scene.remove(p.mesh);
      p.mesh.material.dispose();
      if (p.geo) p.geo.dispose();
    }
    this.portals.length = 0;
  }
}