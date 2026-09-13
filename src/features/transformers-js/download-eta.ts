import type { DownloadProgressSnapshot } from './download-progress';
import type { ProgressInfo } from './types';

/** Source-clock samples only. Host time detects stale delivery, never throughput. */
export function createDownloadEtaEstimator({ now }: { now: () => number }) {
  let sample: { clockId: string; requestId: number; sequence: number; observedAtMs: number; loaded: number } | undefined;
  let firstAt = 0;
  let lastArrival = -Infinity;
  let rate: number | undefined;
  let stalled = false;
  return {
    observe({ info }: { info: ProgressInfo }): void {
      const timing = info.downloadTiming;
      if (timing === 'unavailable') {
        sample = undefined; rate = undefined; firstAt = 0; lastArrival = -Infinity; stalled = false;
        return;
      }
      if (timing === undefined || info.loaded === undefined) return;
      if (sample?.clockId === timing.clockId && timing.sequence <= sample.sequence) return;
      const next = { ...timing, loaded: info.loaded };
      if (sample === undefined || sample.clockId !== timing.clockId || sample.requestId !== timing.requestId
        || timing.observedAtMs - sample.observedAtMs > 10_000 || now() - lastArrival > 10_000 || info.loaded < sample.loaded) {
        sample = next; firstAt = timing.observedAtMs; rate = undefined; stalled = false; lastArrival = now(); return;
      }
      const dt = timing.observedAtMs - sample.observedAtMs;
      if (dt <= 0) return;
      lastArrival = now();
      if (dt < 1_000) return;
      const delta = info.loaded - sample.loaded;
      const measured = delta * 1_000 / dt;
      // Ten seconds is a smoothing policy, not a measured platform constant.
      const alpha = 1 - Math.exp(-dt / 10_000);
      rate = rate === undefined ? measured : alpha * measured + (1 - alpha) * rate;
      sample = next;
      stalled = delta <= 0;
    },
    snapshot({ remainingBytes, active }: { remainingBytes: number | undefined; active: boolean }): DownloadProgressSnapshot['downloadEta'] {
      if (!active || remainingBytes === undefined || remainingBytes <= 0) return { status: 'unavailable' };
      if (sample === undefined) return { status: 'unavailable' };
      if (now() - lastArrival >= 10_000 && sample !== undefined || stalled) return { status: 'stalled' };
      if (sample.observedAtMs - firstAt < 3_000 || rate === undefined || rate <= 0) return { status: 'warming-up' };
      const remainingSeconds = remainingBytes / rate;
      if (!Number.isFinite(remainingSeconds)) return { status: 'unavailable' };
      return { status: 'estimating', remainingSeconds, bytesPerSecond: rate };
    },
  };
}

export const TEST_ONLY = {
};
