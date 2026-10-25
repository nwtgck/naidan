import { parseGenerationMetrics, reportGenerationMetrics, type GenerationMetrics, type GenerationMetricsObserver, type GenerationSpeed } from '@/01-models/generation-metrics';

export const LIVE_SPEED_INTERVAL_MS = 1000;
export const LIVE_SPEED_STALE_MS = 5000;
export const MIN_OBSERVED_INTERVAL_MS = 800;

export function createMetricsReporter({ observer, now = () => performance.now() }: { observer: GenerationMetricsObserver | undefined, now?: () => number }) {
  let lastPublished = -Infinity;
  return ({ metrics, force = false }: { metrics: GenerationMetrics | undefined, force?: boolean }): void => {
    if (metrics === undefined) {
      return;
    }
    const time = now();
    if (!force && time - lastPublished < LIVE_SPEED_INTERVAL_MS) {
      return;
    }
    lastPublished = time;
    reportGenerationMetrics({ observer, metrics });
  };
}

export function createTokenMetrics({ measurement, nInputTokens, nOutputTokens, nMeasuredTokens, durationMs, perSecond }: {
  measurement: Extract<GenerationSpeed, { unit: 'tokens' }>['measurement'],
  nInputTokens?: number,
  nOutputTokens?: number,
  nMeasuredTokens?: number,
  durationMs?: number,
  perSecond?: number,
}): GenerationMetrics | undefined {
  if (nOutputTokens === 0) {
    return undefined;
  }
  const interval = nMeasuredTokens !== undefined && durationMs !== undefined && Number.isSafeInteger(nMeasuredTokens) && nMeasuredTokens > 0 && Number.isFinite(durationMs) && durationMs > 0
    ? { nUnits: nMeasuredTokens, durationMs }
    : undefined;
  const value = interval === undefined ? perSecond : interval.nUnits / interval.durationMs * 1000;
  return parseGenerationMetrics({
    value: {
      ...(nInputTokens === undefined ? {} : { nInputTokens }),
      ...(nOutputTokens === undefined ? {} : { nOutputTokens }),
      speed: { unit: 'tokens', measurement, perSecond: value, ...(interval === undefined ? {} : { interval }) },
    },
  });
}

/** Constant-space, same-clock sample intervals. Call only for non-EOG tokens. */
export function createTokenSpeedMeter() {
  let nOutputTokens = 0;
  let first = 0;
  let last = 0;
  return {
    sample({ now }: { now: number }): void {
      if (nOutputTokens++ === 0) {
        first = now;
      }
      last = now;
    },
    snapshot({ live }: { live: boolean }): GenerationMetrics | undefined {
      if (nOutputTokens < 2 || (live && last - first < MIN_OBSERVED_INTERVAL_MS)) {
        return undefined;
      }
      return createTokenMetrics({ measurement: 'worker_sample_interval', nOutputTokens, nMeasuredTokens: nOutputTokens - 1, durationMs: last - first });
    },
  };
}

/** Counts code points, not chunks or UTF-16 units. A split pair belongs to the field where it began. */
export function createReceivedTextMeter() {
  const trailingHighSurrogates = new Set<string>();
  let nCharacters = 0;
  let nFirstCharacters = 0;
  let nEvents = 0;
  let first = 0;
  let last = 0;
  return {
    observe({ fields, now }: { fields: readonly { key: string, text: string }[], now: number }): void {
      let meaningful = false;
      for (const { key, text } of fields) {
        if (text.length === 0) {
          continue;
        }
        meaningful = true;
        let atStart = true;
        const previousHigh = trailingHighSurrogates.delete(key);
        let endsHigh = false;
        for (const character of text) {
          const code = character.charCodeAt(0);
          if (!(atStart && previousHigh && code >= 0xdc00 && code <= 0xdfff)) {
            nCharacters++;
          }
          endsHigh = character.length === 1 && code >= 0xd800 && code <= 0xdbff;
          atStart = false;
        }
        if (endsHigh) {
          trailingHighSurrogates.add(key);
        }
      }
      if (!meaningful) {
        return;
      }
      if (nEvents++ === 0) {
        first = now;
        nFirstCharacters = nCharacters;
      }
      last = now;
    },
    snapshot(): GenerationMetrics | undefined {
      const nUnits = nCharacters - nFirstCharacters;
      const durationMs = last - first;
      if (nEvents < 2 || durationMs < MIN_OBSERVED_INTERVAL_MS || nUnits <= 0) {
        return undefined;
      }
      return parseGenerationMetrics({ value: { speed: { unit: 'characters', measurement: 'received_text', perSecond: nUnits / durationMs * 1000, interval: { nUnits, durationMs } } } });
    },
  };
}

/** Only homogeneous engine/sample intervals can describe a whole tool-assisted turn. */
export function aggregateGenerationMetrics({ calls }: { calls: readonly (GenerationMetrics | undefined)[] }): GenerationMetrics | undefined {
  const last = calls.at(-1);
  if (last === undefined || calls.length < 2 || last.speed.measurement === 'received_text' || last.speed.measurement === 'client_request') {
    return undefined;
  }
  let nUnits = 0;
  let durationMs = 0;
  let nOutputTokens = 0;
  for (const call of calls) {
    if (call === undefined || call.speed.measurement !== last.speed.measurement || call.speed.unit !== last.speed.unit || call.speed.interval === undefined || call.nOutputTokens === undefined) {
      return undefined;
    }
    nUnits += call.speed.interval.nUnits;
    durationMs += call.speed.interval.durationMs;
    nOutputTokens += call.nOutputTokens;
  }
  // Input counts across tool loops are not a count of unique prompt tokens.
  return createTokenMetrics({ measurement: last.speed.measurement, nOutputTokens, nMeasuredTokens: nUnits, durationMs });
}

export const TEST_ONLY = {
};
