export type HomeBrandGeometry = {
  sourceLeft: number;
  sourceTop: number;
  sourceMarkWidth: number;
  sourceMarkHeight: number;
  sourceFontSize: number;
  sourceGap: number;
  targetLeft: number;
  targetTop: number;
  targetWidth: number;
  targetHeight: number;
  targetMarkWidth: number;
  targetMarkHeight: number;
  targetFontSize: number;
  targetGap: number;
};

export function homeBrandFrame({ geometry, scrollY }: { geometry: HomeBrandGeometry; scrollY: number }): {
  x: number;
  y: number;
  markWidth: number;
  markHeight: number;
  fontSize: number;
  gap: number;
  progress: number;
} {
  const range = Math.max(1, geometry.sourceTop - geometry.targetTop);
  const progress = Math.max(0, Math.min(1, scrollY / range));
  const remaining = 1 - progress;
  return {
    x: (geometry.sourceLeft - geometry.targetLeft) * remaining,
    y: (geometry.sourceTop - geometry.targetTop) * remaining,
    markWidth: geometry.targetMarkWidth + (geometry.sourceMarkWidth - geometry.targetMarkWidth) * remaining,
    markHeight: geometry.targetMarkHeight + (geometry.sourceMarkHeight - geometry.targetMarkHeight) * remaining,
    fontSize: geometry.targetFontSize + (geometry.sourceFontSize - geometry.targetFontSize) * remaining,
    gap: geometry.targetGap + (geometry.sourceGap - geometry.targetGap) * remaining,
    progress,
  };
}
