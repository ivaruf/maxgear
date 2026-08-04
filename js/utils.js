export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (lo, hi) => lo + Math.random() * (hi - lo);
export const randInt = (lo, hi) => Math.floor(rand(lo, hi + 1));
export const choice = (arr) => arr[(Math.random() * arr.length) | 0];
export const chance = (p) => Math.random() < p;
export const dist2 = (ax, az, bx, bz) => {
  const dx = ax - bx, dz = az - bz;
  return dx * dx + dz * dz;
};
export const circleHit = (a, b) => {
  const r = a.radius + b.radius;
  return dist2(a.x, a.z, b.x, b.z) < r * r;
};
// Remove entities flagged dead via swap-remove (order not preserved)
export function sweepDead(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].dead) {
      arr[i] = arr[arr.length - 1];
      arr.pop();
    }
  }
}
