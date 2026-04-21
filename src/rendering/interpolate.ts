export const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export function lerpKeyframe(kfs: Array<{ t: number; v: number }> | undefined, time: number, fallback: number) {
  if (!kfs || !kfs.length) return fallback;
  const sorted = [...kfs].sort((a, b) => a.t - b.t);
  if (time <= sorted[0].t) return Number(sorted[0].v);
  if (time >= sorted[sorted.length - 1].t) return Number(sorted[sorted.length - 1].v);
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (time >= a.t && time <= b.t) {
      const p = (time - a.t) / Math.max(0.0001, b.t - a.t);
      return Number(a.v) + (Number(b.v) - Number(a.v)) * p;
    }
  }
  return fallback;
}
