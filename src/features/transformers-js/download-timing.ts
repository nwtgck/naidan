import { z } from 'zod';

// Observation limits bound retained metadata, not acquisition or model support.
const duration = z.number().finite().nonnegative().max(7 * 24 * 60 * 60 * 1_000);
const clockIdentity = z.string().uuid();
const modelIdentity = z.string().max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u);
const revision = z.string().max(64).regex(/^(?:[a-fA-F0-9]{40}|main)$/u);
const candidate = z.object({ device: z.enum(['webgpu', 'wasm']), dtype: z.string().max(32).regex(/^[a-zA-Z0-9_-]+$/u) });
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const cleanup = z.enum(['completed', 'failed', 'unknown']);

function withinRawTimingBudget({ value }: { value: unknown }): boolean {
  let nodes = 0;
  let characters = 0;
  function visit({ item, depth }: { item: unknown; depth: number }): boolean {
    if (++nodes > 65_536 || depth > 12) return false;
    if (typeof item === 'string') {
      characters += item.length;
      return item.length <= 256 && characters <= 524_288;
    }
    if (item === null || typeof item !== 'object') return true;
    if (Array.isArray(item)) return item.length <= 128 && item.every(child => visit({ item: child, depth: depth + 1 }));
    const keys = Object.keys(item);
    if (keys.length > 32) return false;
    return keys.every(key => {
      const property = Object.getOwnPropertyDescriptor(item, key);
      return property !== undefined && 'value' in property && visit({ item: property.value, depth: depth + 1 });
    });
  }
  try {
    return visit({ item: value, depth: 0 });
  } catch {
    return false;
  }
}

export const downloadFileTimingSchema = z.object({
  version: z.literal(1),
  clockId: clockIdentity.optional(),
  status: z.enum(['measured', 'unavailable']),
  saveMethod: z.enum(['staging-copy', 'direct']),
  admissionMs: duration.optional(),
  responseWaitMs: duration.optional(),
  streamMs: duration.optional(),
  eofToVerifiedMs: duration.optional(),
});
export type DownloadFileTiming = z.infer<typeof downloadFileTimingSchema>;
export const downloadSourceTimingSchema = z.object({
  version: z.literal(1), clockId: clockIdentity.optional(),
  status: z.enum(['measured', 'unavailable']),
  callMs: duration.optional(), finalizationMs: duration.optional(),
  droppedFiles: counter.optional(),
});
export type DownloadSourceTiming = z.infer<typeof downloadSourceTimingSchema>;

export const downloadAcceptanceTimingSchema = z.object({
  kind: z.literal('acceptance'), version: z.literal(1),
  // The actual cache/loader revision (including legacy main), not the remote
  // repository's resolved SHA. Association does not prove byte equivalence.
  route: z.enum(['candidate', 'revision']), revision,
  candidate: candidate.optional(), clockId: clockIdentity.optional(),
  timingStatus: z.enum(['measured', 'unavailable']), hostDurationMs: duration.optional(),
  loadOutcome: z.enum(['accepted', 'rejected', 'failed', 'unknown']),
  cleanupOutcome: cleanup, hostSettlement: z.enum(['fulfilled', 'rejected']),
  attemptCount: z.union([counter.max(128), z.literal('unknown')]),
});
export type DownloadAcceptanceTiming = z.infer<typeof downloadAcceptanceTimingSchema>;
export const downloadPrefetchTimingSchema = z.object({
  kind: z.literal('prefetch'), version: z.literal(1), revision, candidate,
  clockId: clockIdentity.optional(), timingStatus: z.enum(['measured', 'unavailable']),
  hostRoundtripMs: duration.optional(), hostFinalizationMs: duration.optional(),
  cleanupOutcome: cleanup, hostSettlement: z.enum(['fulfilled', 'rejected']),
  source: downloadSourceTimingSchema.optional(),
  droppedFiles: counter,
  files: z.array(z.object({
    // Relative selected artifact identity only; never URLs, errors or bodies.
    path: z.string().max(256).regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9._/-]+$/u),
    outcome: z.enum(['cached', 'downloaded', 'failed']),
    bytes: counter.optional(), timing: downloadFileTimingSchema.optional(),
  })).max(128),
});
export type DownloadPrefetchTiming = z.infer<typeof downloadPrefetchTimingSchema>;
export const downloadTimingObservationSchema = z.preprocess(value => withinRawTimingBudget({ value }) ? value : undefined, z.discriminatedUnion('kind', [downloadAcceptanceTimingSchema, downloadPrefetchTimingSchema]));
export type DownloadTimingObservation = z.infer<typeof downloadTimingObservationSchema>;
export type DownloadTimingCallback = ({ observation }: { observation: DownloadTimingObservation }) => void;

function observationScalarCount({ observation }: { observation: DownloadTimingObservation }): number {
  switch (observation.kind) {
  case 'prefetch': return 1 + observation.files.length;
  case 'acceptance': return 1;
  default: {
    const exhaustive: never = observation;
    throw new Error(`Unhandled timing observation: ${String(exhaustive)}`);
  }
  }
}

// A measured operation wall and completed outcome describe that owned call,
// not complete instrumentation of every internal stage. Even truncated=false
// means only that this collector observed no budget loss: missing stage
// observations remain unknown and must never be imputed as zero-duration work.
const operationSchema = z.object({
  operationId: z.string().max(160).regex(/^[0-9a-f-]{36}\/[0-9]+$/u).optional(), modelId: modelIdentity.optional(), runtimeEpoch: counter,
  outcome: z.enum(['running', 'completed', 'failed', 'aborted', 'retired']),
  wallMs: duration.optional(), timingStatus: z.enum(['measured', 'unavailable']),
  truncated: z.boolean(), droppedObservations: counter,
  observations: z.array(downloadTimingObservationSchema).max(128),
});
export const downloadTimingSnapshotSchema = z.preprocess(value => withinRawTimingBudget({ value }) ? value : undefined, z.object({
  format: z.literal('transformers-js-download-timing-v1'), measurementVersion: z.literal(1),
  source: z.literal('ordinary-download'), serviceEpoch: clockIdentity.optional(), sequence: counter,
  identityStatus: z.enum(['available', 'unavailable']),
  availability: z.enum(['recorded', 'unavailable-in-this-service-session']),
  droppedOperations: counter, records: z.array(operationSchema).max(8),
}).superRefine((value, context) => {
  const scalars = value.records.reduce((sum, record) => sum + record.observations.reduce((count, observation) => count + observationScalarCount({ observation }), 0), 0);
  if (scalars > 1_024 || JSON.stringify(value).length > 524_288) context.addIssue({ code: 'custom', message: 'Download timing retention budget exceeded' });
}));
export type DownloadTimingSnapshot = z.infer<typeof downloadTimingSnapshotSchema>;

/** Advisory parsing must never promote malformed measurement data to I/O failure. */
export function parseDownloadTiming<T>({ schema, value }: { schema: z.ZodType<T>; value: unknown }): T | undefined {
  try {
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function publishDownloadTiming({ callback, observation }: { callback: DownloadTimingCallback | undefined; observation: DownloadTimingObservation }): void {
  try {
    const parsed = parseDownloadTiming({ schema: downloadTimingObservationSchema, value: observation });
    if (parsed !== undefined) void Promise.resolve(callback?.({ observation: parsed })).catch(() => undefined);
  } catch {
    // This callback observes an already owned operation, never controls it.
  }
}

export function createDownloadMeasurementClock() {
  let clockId: string | undefined;
  try {
    clockId = crypto.randomUUID();
  } catch { /* Timing only. */ }
  let last: number | undefined;
  let valid = clockId !== undefined;
  return {
    clockId,
    read(): number | undefined {
      if (!valid) return undefined;
      try {
        const now = performance.now();
        if (!Number.isFinite(now) || now < 0 || now > Number.MAX_SAFE_INTEGER || (last !== undefined && now < last)) throw new Error('Invalid observation clock');
        last = now;
        return now;
      } catch {
        valid = false; return undefined;
      }
    },
    elapsed({ start, end }: { start: number | undefined; end: number | undefined }): number | undefined {
      if (!valid || start === undefined || end === undefined) return undefined;
      const result = duration.safeParse(end - start);
      if (!result.success) {
        valid = false; return undefined;
      }
      return result.data;
    },
  };
}

/** Observe the existing disposal, including synchronous throws, without changing
 * its fulfilled/rejected outcome or replacing its original rejection. */
export async function disposeWithDownloadTiming({ dispose, onOutcome }: {
  dispose: () => Promise<void>;
  onOutcome: ({ outcome }: { outcome: 'completed' | 'failed' }) => void;
}): Promise<void> {
  function report({ outcome }: { outcome: 'completed' | 'failed' }): void {
    try {
      void Promise.resolve(onOutcome({ outcome })).catch(() => undefined);
    } catch {
      // The measurement observer has no disposal authority.
    }
  }
  try {
    await dispose();
  } catch (error) {
    report({ outcome: 'failed' });
    throw error;
  }
  report({ outcome: 'completed' });
}

export async function measureDownloadAcceptance<T extends { status: 'accepted' | 'rejected' | 'failed' }>({
  revision: selectedRevision, candidate: selectedCandidate, route, callback, operation,
}: {
  revision: string; candidate: DownloadAcceptanceTiming['candidate']; route: DownloadAcceptanceTiming['route'];
  callback: DownloadTimingCallback | undefined;
  operation: ({ attempt, cleanup, load }: {
    attempt: ({ count }: { count: number | 'unknown' }) => void;
    cleanup: ({ outcome }: { outcome: DownloadAcceptanceTiming['cleanupOutcome'] }) => void;
    load: ({ outcome }: { outcome: DownloadAcceptanceTiming['loadOutcome'] }) => void;
  }) => Promise<T>;
}): Promise<T> {
  const clock = createDownloadMeasurementClock();
  const started = clock.read();
  let loadOutcome: DownloadAcceptanceTiming['loadOutcome'] = 'unknown';
  let cleanupOutcome: DownloadAcceptanceTiming['cleanupOutcome'] = 'unknown';
  let hostSettlement: DownloadAcceptanceTiming['hostSettlement'] = 'rejected';
  let attemptCount: DownloadAcceptanceTiming['attemptCount'] = 0;
  try {
    const result = await operation({
      attempt: ({ count }) => {
        attemptCount = count === 'unknown' || attemptCount === 'unknown' ? 'unknown' : attemptCount + count;
      },
      cleanup: ({ outcome }) => {
        cleanupOutcome = outcome;
      },
      load: ({ outcome }) => {
        loadOutcome = outcome;
      },
    });
    loadOutcome = result.status;
    hostSettlement = 'fulfilled';
    return result;
  } finally {
    const hostDurationMs = clock.elapsed({ start: started, end: clock.read() });
    publishDownloadTiming({ callback, observation: {
      kind: 'acceptance', version: 1, route, revision: selectedRevision, candidate: selectedCandidate,
      clockId: clock.clockId, timingStatus: hostDurationMs === undefined ? 'unavailable' : 'measured', hostDurationMs,
      loadOutcome, cleanupOutcome, hostSettlement, attemptCount,
    } });
  }
}

export function createDownloadTimingCollector() {
  let serviceEpoch: string | undefined;
  try {
    serviceEpoch = crypto.randomUUID();
  } catch { /* Missing identity is not a Download failure. */ }
  let sequence = 0;
  let droppedOperations = 0;
  const records: DownloadTimingSnapshot['records'] = [];
  return {
    begin({ modelId, runtimeEpoch }: { modelId: string; runtimeEpoch: number }) {
      const clock = createDownloadMeasurementClock();
      const started = clock.read();
      const record: DownloadTimingSnapshot['records'][number] = {
        operationId: serviceEpoch === undefined ? undefined : `${serviceEpoch}/${sequence + 1}`, modelId: modelIdentity.safeParse(modelId).success ? modelId : undefined, runtimeEpoch,
        outcome: 'running', timingStatus: 'unavailable', truncated: false, droppedObservations: 0, observations: [],
      };
      sequence++;
      if (records.length === 8) {
        records.shift(); droppedOperations++;
      }
      records.push(record);
      let active = true;
      let scalarCount = 0;
      return {
        observe({ observation }: { observation: DownloadTimingObservation }): void {
          if (!active || record.outcome !== 'running' || !records.includes(record)) return;
          const parsed = parseDownloadTiming({ schema: downloadTimingObservationSchema, value: observation });
          const cost = parsed === undefined ? 1 : observationScalarCount({ observation: parsed });
          if (parsed === undefined || scalarCount + cost > 128 || JSON.stringify(record).length + JSON.stringify(parsed).length > 60_000) {
            record.truncated = true; record.droppedObservations++; return;
          }
          scalarCount += cost;
          record.observations.push(parsed);
          if (parsed.kind === 'prefetch' && parsed.droppedFiles > 0) record.truncated = true;
        },
        finish({ outcome }: { outcome: Exclude<DownloadTimingSnapshot['records'][number]['outcome'], 'running'> }): void {
          if (!active || record.outcome !== 'running') return;
          active = false;
          record.outcome = outcome;
          record.wallMs = clock.elapsed({ start: started, end: clock.read() });
          record.timingStatus = record.wallMs === undefined ? 'unavailable' : 'measured';
        },
      };
    },
    snapshot(): DownloadTimingSnapshot {
      return downloadTimingSnapshotSchema.parse({ format: 'transformers-js-download-timing-v1', measurementVersion: 1, source: 'ordinary-download', serviceEpoch, identityStatus: serviceEpoch === undefined ? 'unavailable' : 'available', sequence, availability: records.length === 0 ? 'unavailable-in-this-service-session' : 'recorded', droppedOperations, records });
    },
    retireActive(): void {
      for (const record of records) {
        switch (record.outcome) {
        case 'running': break;
        case 'completed':
        case 'failed':
        case 'aborted':
        case 'retired': continue;
        default: {
          const exhaustive: never = record.outcome;
          throw new Error(`Unhandled timing operation outcome: ${exhaustive}`);
        }
        }
        // Losing the service owner is not proof of I/O or cleanup completion.
        // Later settlement cannot turn this censored observation into success.
        record.outcome = 'retired';
        record.wallMs = undefined;
        record.timingStatus = 'unavailable';
      }
    },
    clear(): void {
      records.length = 0;
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
