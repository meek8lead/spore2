import * as THREE from 'three';
import { CONFIG, mulberry32, vnoise3 } from './config.js';

// ─── Medium ────────────────────────────────────────────────────────────────
export class Medium {
  sample(x, y, z) {
    const s = CONFIG.medium.scale;
    const w = CONFIG.medium.warp;
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

// ─── Ecosystem ─────────────────────────────────────────────────────────────
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
    const rng = mulberry32(seed);
    const baseHue = rng() * 360;
    const n = CONFIG.palette.size;
    for (let i = 0; i < n; i++) {
      const h = ((baseHue + (i * 360) / n + rng() * 24) % 360) / 360;
      const s = 0.45 + rng() * 0.4;
      const l = 0.32 + rng() * 0.42;
      this.baseHSL.push({ h, s, l });
      this.colors.push(new THREE.Color().setHSL(h, s, l));
      this.uniformArray.push(new THREE.Vector3());
    }
    this.refresh();
  }
  update(dt) { this.t += dt; this.refresh(); }
  refresh() {
    const shift = this.t * CONFIG.palette.cycleSpeed;
    for (let i = 0; i < this.baseHSL.length; i++) {
      const b = this.baseHSL[i];
      const h = (b.h + shift * 0.03 + 1) % 1;
      const l = Math.max(0.08, Math.min(0.92, b.l + Math.sin(this.t * 0.3 + i * 0.7) * 0.05));
      const c = this.colors[i].setHSL(h, b.s, l);
      this.uniformArray[i].set(c.r, c.g, c.b);
    }
  }
}

// ─── Background (skybox shader) ────────────────────────────────────────────
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
        float t=uTime*0.04;
        vec3 w=vec3(snoise(d*2.0+t),snoise(d*2.0+t+10.0),snoise(d*2.0+t+20.0))*0.7;
        float a=snoise(d*3.0+w+t*0.3)*0.5+0.5;
        float b=snoise(d*7.0+w*2.0-t*0.2)*0.5+0.5;
        float v=mix(a,b,0.45);
        vec3 col=paletteLookup(v);
        col*=mix(0.35,1.0,d.y*0.5+0.5);
        float band=sin(d.y*9.0+uTime*0.2)*0.5+0.5;
        col=mix(col,paletteLookup(band*0.9),0.18);
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

// ─── FoodField ─────────────────────────────────────────────────────────────
export class FoodField {
  constructor(scene, palette, seed = 99) {
    this.rng = mulberry32(seed);
    this.foods = [];
    this.group = new THREE.Group();
    this.geo = new THREE.IcosahedronGeometry(0.28, 0);
    scene.add(this.group);
    for (let i = 0; i < CONFIG.world.foodCount; i++) this.spawnAround(new THREE.Vector3(), palette);
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
    const toxic = Math.random() < CONFIG.food.toxicChance;
    const colorIdx = toxic ? 3 : Math.floor(this.rng() * palette.colors.length);
    const mat = new THREE.MeshBasicMaterial({ color: palette.colors[colorIdx].clone() });
    const mesh = new THREE.Mesh(this.geo, mat);
    mesh.position.copy(pos);
    this.group.add(mesh);
    this.foods.push({ mesh, energy: 8 + ecoLevel * 30, alive: true, toxic });
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
  tryEat(pos, range) {
    let energy = 0;
    let toxicCount = 0;
    for (const f of this.foods) {
      if (!f.alive) continue;
      if (f.mesh.position.distanceTo(pos) < range) {
        f.alive = false;
        f.mesh.visible = false;
        energy += f.toxic ? f.energy * CONFIG.food.toxicEnergyMult : f.energy;
        if (f.toxic) toxicCount++;
      }
    }
    return { energy, toxicCount };
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
      f.toxic = Math.random() < CONFIG.food.toxicChance;
      const idx = f.toxic ? 3 : Math.floor(this.rng() * palette.colors.length);
      f.mesh.material.color.copy(palette.colors[idx]);
    }
  }
}

// ─── Npc ───────────────────────────────────────────────────────────────────
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

    const geo = new THREE.IcosahedronGeometry(type.size, 1);
    const colorIdx = type.damage > 0 ? 5 : Math.floor(Math.random() * palette.colors.length);
    this.baseColor = palette.colors[colorIdx].clone();
    this.material = new THREE.MeshBasicMaterial({ color: this.baseColor.clone() });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.position.copy(this.position);
    scene.add(this.mesh);
  }
  update(dt, playerPos) {
    if (!this.alive) return;
    this.phase += dt;
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
    }

    const desired = target.sub(this.position);
    if (desired.lengthSq() > 0.0001) desired.normalize().multiplyScalar(speed);
    this.velocity.lerp(desired, 1 - Math.exp(-3 * dt));
    this.position.addScaledVector(this.velocity, dt);
    this.mesh.position.copy(this.position);
    this.mesh.rotation.x += dt * 0.8;
    this.mesh.rotation.y += dt * 1.1;

    if (this.attached) this.material.color.copy(this.baseColor).multiplyScalar(1.4);
    else this.material.color.copy(this.baseColor);
  }
  tryHit() {
    if (this.attached) return false;
    if (this.type.damage <= 0) return false;
    return true;
  }
  kill() {
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