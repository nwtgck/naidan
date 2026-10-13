export type HomeBrandGeometry = {
  sourceLeft: number;
  sourceTop: number;
  sourceWidth: number;
  targetLeft: number;
  targetTop: number;
  targetWidth: number;
};

export function homeBrandTransform({ geometry, scrollY }: { geometry: HomeBrandGeometry; scrollY: number }): {
  x: number;
  y: number;
  scale: number;
  progress: number;
} {
  const range = Math.max(1, geometry.sourceTop - geometry.targetTop);
  const progress = Math.max(0, Math.min(1, scrollY / range));
  const remaining = 1 - progress;
  return {
    x: (geometry.sourceLeft - geometry.targetLeft) * remaining,
    y: (geometry.sourceTop - geometry.targetTop) * remaining,
    scale: 1 + (geometry.sourceWidth / geometry.targetWidth - 1) * remaining,
    progress,
  };
}
