import type { PreviewFrame, PreviewSettings } from './types';

/** Display geometry only. Projection frames may be only a few latent pixels
 * wide; fill the chosen preview size without re-encoding their Blob. A zero
 * cap explicitly requests native size. CSS still clamps to the available width.
 * Detailed decoder frames are never enlarged beyond their actual resolution. */
export function previewDisplaySize({ frame, maxEdge }: {
  frame: Pick<PreviewFrame, 'width' | 'height' | 'mode'>,
  maxEdge: PreviewSettings['maxEdge'],
}): { width: number, height: number } {
  const { width, height } = frame;
  if (maxEdge === 0) return { width, height };
  const ratio = maxEdge / Math.max(width, height);
  const scale = (() => {
    switch (frame.mode) {
    case 'projection': return ratio;
    case 'vae': return Math.min(1, ratio);
    default: { const exhaustive: never = frame.mode; throw new Error(String(exhaustive)); }
    }
  })();
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export const TEST_ONLY = {
};
