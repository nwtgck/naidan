export type ThroughputSample = { startedAt: number, sampledAt: number, processed: number, lastAdvanceAt: number | undefined, bytesPerSecond: number | undefined };
export type DownloadEstimate = { status: 'estimating' } | { status: 'verifying' } | { status: 'remaining', seconds: number };
export function startThroughputSample({ now }: { now: number }): ThroughputSample {
  return { startedAt: now, sampledAt: now, processed: 0, lastAdvanceAt: undefined, bytesPerSecond: undefined };
}
/** Sample cumulative work on the UI clock, independently of progress event frequency. */
export function advanceThroughputSample({ sample, now, processed }: { sample: ThroughputSample, now: number, processed: number }): ThroughputSample {
  const elapsed = now - sample.sampledAt;
  if (elapsed <= 0) return sample;
  const bytes = processed - sample.processed;
  if (bytes < 0) return { ...startThroughputSample({ now }), processed };
  const instantaneous = bytes * 1000 / elapsed;
  // A time-weighted EMA retains roughly ten seconds of throughput history.
  const weight = -Math.expm1(-elapsed / 10000);
  const bytesPerSecond = sample.bytesPerSecond === undefined ? (bytes > 0 ? instantaneous : undefined) : sample.bytesPerSecond + weight * (instantaneous - sample.bytesPerSecond);
  return { ...sample, sampledAt: now, processed, lastAdvanceAt: bytes > 0 ? now : sample.lastAdvanceAt, bytesPerSecond };
}
export function remainingEstimate({ sample, now, remaining, phase }: { sample: ThroughputSample, now: number, remaining: number, phase: 'transferring' | 'verifying' }): DownloadEstimate {
  switch (phase) {
  case 'verifying': return { status: 'verifying' };
  case 'transferring': break;
  default: { const exhaustive: never = phase; throw new Error(String(exhaustive)); }
  }
  if (now - sample.startedAt < 3000 || sample.lastAdvanceAt === undefined || now - sample.lastAdvanceAt >= 10000 || !sample.bytesPerSecond || remaining <= 0) return { status: 'estimating' };
  return { status: 'remaining', seconds: Math.max(1, remaining / sample.bytesPerSecond) };
}
export const TEST_ONLY = {
};
