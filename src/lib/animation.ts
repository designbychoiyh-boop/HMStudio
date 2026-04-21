import { Keyframe } from '@/src/types/editor';

export const getInterpolatedValue = (
  keyframes: Keyframe[] | undefined,
  time: number,
  fallback: number,
): number => {
  if (!keyframes || keyframes.length === 0) return fallback;

  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  if (time <= sorted[0].time) return sorted[0].value;
  if (time >= sorted[sorted.length - 1].time) return sorted[sorted.length - 1].value;

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (time >= a.time && time <= b.time) {
      const span = Math.max(0.0001, b.time - a.time);
      const t = (time - a.time) / span;
      return a.value + (b.value - a.value) * t;
    }
  }

  return fallback;
};
