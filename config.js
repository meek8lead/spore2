export const CONFIG = {
  render: { internalHeight: 270, maxDt: 1 / 20 },
  palette: { size: 16, cycleSpeed: 0.06 },
  medium: { scale: 0.008, warp: 0.6 },
  behavior: { rate: 0.15, pulseDecay: 2.5, foodPulse: 0.6, npcPulse: 0.9, scavengingPulse: 0.5 },
  player: {
    accel: 14, maxSpeed: 8, drag: 2.4, baseEnergy: 100, drainIdle: 1.2, drainMove: 3.4,
    passiveGain: 0.35, eatRange: 1.1,
    massStart: 1.0, massMin: 0.3, massMax: 8.0, massGrowth: 0.05, massDecay: 0.05,
    mitosisCooldown: 2.0, ecoLevelPerMitosis: 0.05,
    lmbBiteRange: 1.8, lmbBiteCost: 4, lmbBiteCooldown: 0.35,
    dashSpeed: 22, dashCost: 15, dashCooldown: 1.2,
    maxHp: 100, hpRegen: 0.8, damageFlashDecay: 3.0,
    respawnDelay: 2.0, respawnEnergyRatio: 0.5, respawnInvuln: 2.0, fadeSpeed: 1.5,
  },
  camera: { distance: 9, height: 3.5, followLerp: 0.12 },
  world: {
    foodCount: 48, foodSpawnRadius: 26,
    ecoNoiseScale: 0.015, ecoRubberRadius: 22, ecoTrueBaseline: 0.3, ecoTrueAmp: 0.5,
  },
  npc: {
    count: 3, respawnDelay: 4, contactDamageCooldown: 1.0,
    patrolRadius: 6, patrolSpeed: 1.2, patrolAggroRange: 8, patrolChaseSpeed: 2.6,
    largeSpawnEco: 0.5,
    types: [
      { name: 'small', size: 0.45, wanderRadius: 5, wanderSpeed: 1.5, fleeRange: 4, fleeStrength: 3, energy: 35, corpseEco: 0.08, damage: 0 },
      { name: 'large', size: 0.95, wanderRadius: 5, wanderSpeed: 1.0, fleeRange: 0, fleeStrength: 0, energy: 90, corpseEco: 0.18, damage: 12 },
    ],
  },
  detritus: { lifetime: 25, energy: 12, pickupRange: 1.2, maxItems: 20 },
  rubberband: {
    lowEnergyThreshold: 0.3, highEnergyThreshold: 0.9,
    lowEnergyDuration: 8, highEnergyDuration: 12,
    foodDensityBoost: 0.6, foodDensityReduce: -0.3, smoothing: 0.5,
  },
  toxicity: { threshold: 0.7, dotPerSec: 6, evasionPulse: 0.05 },
  food: { toxicChance: 0.15, toxicEnergyMult: 0.5, toxicPulse: 0.4 },
  stages: { colonyThreshold: 1.0, multicellularThreshold: 2.5 },
  colony: {
    symbiosisRange: 2.5, symbiosisBreakRange: 4.0,
    symbiosisDuration: 3.0, symbiosisEnergyPerSec: 6, symbiosisPulseRate: 0.4,
  },
};

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function vnoise3(x, y, z, seed = 0) {
  const h = (ix, iy, iz) => {
    let n = (ix * 374761393 + iy * 668265263 + iz * 2147483647 + seed * 982451653) | 0;
    n = (n ^ (n >> 13)) | 0;
    n = Math.imul(n, 1274126177) | 0;
    return ((n ^ (n >> 16)) >>> 0) / 4294967296;
  };
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  const n000 = h(ix, iy, iz), n100 = h(ix + 1, iy, iz);
  const n010 = h(ix, iy + 1, iz), n110 = h(ix + 1, iy + 1, iz);
  const n001 = h(ix, iy, iz + 1), n101 = h(ix + 1, iy, iz + 1);
  const n011 = h(ix, iy + 1, iz + 1), n111 = h(ix + 1, iy + 1, iz + 1);
  const x00 = n000 + (n100 - n000) * ux;
  const x10 = n010 + (n110 - n010) * ux;
  const x01 = n001 + (n101 - n001) * ux;
  const x11 = n011 + (n111 - n011) * ux;
  const y0 = x00 + (x10 - x00) * uy;
  const y1 = x01 + (x11 - x01) * uy;
  return y0 + (y1 - y0) * uz;
}