/** Deterministic seeded RNG (mulberry32). Same seed => identical city. */
export function makeRNG(seed = 1337) {
  let a = seed >>> 0;
  const rng = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (lo, hi) => lo + rng() * (hi - lo);
  rng.int = (lo, hi) => Math.floor(lo + rng() * (hi - lo + 1));
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  /** Weighted pick: entries = [[value, weight], ...] */
  rng.weighted = (entries) => {
    let total = 0;
    for (const e of entries) total += e[1];
    let r = rng() * total;
    for (const e of entries) { r -= e[1]; if (r <= 0) return e[0]; }
    return entries[entries.length - 1][0];
  };
  rng.chance = (p) => rng() < p;
  rng.sign = () => (rng() < 0.5 ? -1 : 1);
  /** Gaussian-ish via sum of uniforms. */
  rng.gauss = (mean = 0, sd = 1) =>
    mean + ((rng() + rng() + rng() + rng() + rng() + rng() - 3) / 1.732) * sd;
  return rng;
}

export const globalRNG = makeRNG(20260803);
