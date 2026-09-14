import { z } from 'zod';
import type { DownloadProgressSnapshot } from './download-progress';
import type { ProgressInfo } from './types';

export const downloadCumulativeTimingSchema = z.object({
  clockId: z.string().min(1).max(128),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  firstFetchStartedAtMs: z.number().finite().nonnegative(),
  observedAtMs: z.number().finite().nonnegative(),
  receivedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict().refine(value => value.observedAtMs >= value.firstFetchStartedAtMs
  && value.observedAtMs - value.firstFetchStartedAtMs <= 7 * 24 * 60 * 60 * 1000);

/** Source-clock wall average. Host time only detects stale delivery. */
export function createDownloadEtaEstimator({ now }: { now: () => number }) {
  let sample: z.infer<typeof downloadCumulativeTimingSchema> | undefined;
  let lastArrival = 0;
  let lastGrowthArrival = 0;
  let unavailable = false;
  function readArrival(): number | undefined {
    try {
      const value = now();
      return Number.isFinite(value) && value >= 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }
  return {
    observe({ info }: { info: ProgressInfo }): void {
      if (unavailable || info.downloadCumulativeTiming === undefined) return;
      const parsed = downloadCumulativeTimingSchema.safeParse(info.downloadCumulativeTiming);
      if (!parsed.success) {
        unavailable = true; return;
      }
      const next = parsed.data;
      if (sample !== undefined) {
        if (next.clockId !== sample.clockId || next.firstFetchStartedAtMs !== sample.firstFetchStartedAtMs) {
          unavailable = true; return;
        }
        if (next.sequence <= sample.sequence) return;
        if (next.observedAtMs < sample.observedAtMs || next.receivedBytes < sample.receivedBytes) {
          unavailable = true; return;
        }
      }
      const arrival = readArrival();
      if (arrival === undefined || sample !== undefined && arrival < lastArrival) {
        unavailable = true; return;
      }
      if (sample === undefined || next.receivedBytes > sample.receivedBytes) lastGrowthArrival = arrival;
      lastArrival = arrival;
      sample = next;
    },
    matchesReceivedBytes({ bytes }: { bytes: number }): boolean {
      // A coalesced notification can arrive before another file's terminal.
      // Do not combine newer source bytes with an older host remaining count.
      return !unavailable && sample !== undefined && sample.receivedBytes === bytes;
    },
    snapshot({ remainingBytes, active }: { remainingBytes: number | undefined; active: boolean }): DownloadProgressSnapshot['downloadEta'] {
      if (!active || remainingBytes === undefined || !Number.isSafeInteger(remainingBytes) || remainingBytes <= 0 || unavailable || sample === undefined) return { status: 'unavailable' };
      const arrival = readArrival();
      if (arrival === undefined || arrival < lastArrival) return { status: 'unavailable' };
      if (arrival - lastArrival >= 10_000 || arrival - lastGrowthArrival >= 10_000) return { status: 'stalled' };
      const elapsedMs = sample.observedAtMs - sample.firstFetchStartedAtMs;
      if (elapsedMs < 3_000 || sample.receivedBytes <= 0) return { status: 'warming-up' };
      // Keep completed saving and inter-file waits in this elapsed time. They
      // are not added again, and ordinary file changes never reset the origin.
      const bytesPerSecond = sample.receivedBytes / (elapsedMs / 1000);
      const remainingSeconds = remainingBytes / bytesPerSecond;
      if (!Number.isFinite(remainingSeconds) || remainingSeconds <= 0 || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return { status: 'unavailable' };
      return { status: 'estimating', remainingSeconds, bytesPerSecond };
    },
  };
}

export const TEST_ONLY = {
};
