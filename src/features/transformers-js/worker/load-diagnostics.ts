import { z } from 'zod';
import { productionLoadReceiptOwnerSchema, type ProductionLoadReceiptOwner } from './load-receipt';

const count = z.number().int().nonnegative().safe();
const errorName = z.enum(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'unknown']);
const incompleteReason = z.enum(['event-limit', 'invalid-event', 'resource-limit', 'transport-failed', 'unobserved-load', 'load-not-settled']);
const resource = z.string().min(1).max(256).regex(/^[A-Za-z0-9_./-]+\.onnx(?:_data(?:_[0-9]+)?)?$/u)
  .refine(value => !value.startsWith('/') && !value.split('/').includes('..'));
export const loadDiagnosticEventSchema = z.object({
  loadOrdinal: count.min(1).max(32), sequence: count.max(512), candidateOrdinal: count.max(32),
  kind: z.enum(['load-start', 'previous-unload-start', 'previous-unload-finished', 'candidate-start',
    'allocation-attempt', 'allocation-succeeded', 'allocation-failed', 'read-start', 'read-returned', 'read-failed',
    'session-preparing', 'session-entering', 'session-fulfilled', 'session-rejected',
    'resource-cleanup-start', 'resource-cleanup-finished', 'resource-cleanup-failed', 'candidate-finished', 'load-finished', 'load-failed', 'diagnostic-incomplete']),
  resource: resource.optional(), readOrdinal: count.max(128).optional(), requestedBytes: count.optional(),
  errorName: errorName.optional(), device: z.enum(['webgpu', 'wasm']).optional(), dtype: z.string().max(32).optional(),
  priorRuntime: z.enum(['present', 'absent']).optional(),
  revision: z.string().max(128).regex(/^(?:[a-f0-9]{40}|main)$/u).optional(),
  candidateScopeAllocatedBytes: count, returnedReadBufferBytes: count, activeReadCount: count.max(128),
  scope: z.enum(['active', 'closed']),
}).strict();
export type LoadDiagnosticEvent = z.infer<typeof loadDiagnosticEventSchema>;
export const loadDiagnosticPacketSchema = z.object({ owner: productionLoadReceiptOwnerSchema, event: loadDiagnosticEventSchema,
  incompleteReasons: z.array(incompleteReason).max(6),
}).strict();
export type LoadDiagnosticPacket = z.infer<typeof loadDiagnosticPacketSchema>;
export const LOAD_DIAGNOSTIC_CHANNEL = 'naidan-production-load-diagnostics';
export const loadDiagnosticMessageSchema = z.object({
  channel: z.literal(LOAD_DIAGNOSTIC_CHANNEL), packet: loadDiagnosticPacketSchema,
}).strict();
export type LoadDiagnosticMessage = z.infer<typeof loadDiagnosticMessageSchema>;
export const loadDiagnosticsSchema = z.object({
  format: z.literal('production-load-diagnostics-v1'), owner: productionLoadReceiptOwnerSchema,
  limits: z.object({ maxEvents: z.literal(512), maxResources: z.literal(128) }).strict(),
  byteAccounting: z.literal('successful-allocation-request-sum-not-live-memory-or-gc'),
  coverage: z.literal('transformers-readResponse-and-session-entry-only-not-response-arrayBuffer-or-ort-internals'),
  events: z.array(loadDiagnosticEventSchema).max(512),
  incompleteReasons: z.array(incompleteReason).max(6),
}).strict();
export type LoadDiagnostics = z.infer<typeof loadDiagnosticsSchema>;
// eslint-disable-next-line local-rules-named-args/require-named-args -- The reviewed third-party bundle invokes this callback positionally.
export type UpstreamLoadDiagnosticObserver = (value: unknown) => void;
type Details = Partial<Pick<LoadDiagnosticEvent, 'resource' | 'readOrdinal' | 'requestedBytes' | 'errorName' | 'device' | 'dtype' | 'priorRuntime' | 'revision'>>;

export function loadDiagnosticErrorDetails({ error }: { error: unknown }): Pick<LoadDiagnosticEvent, 'errorName'> {
  try {
    const name = errorName.safeParse(typeof error === 'object' && error !== null ? Reflect.get(error, 'name') : undefined);
    return { errorName: name.success ? name.data : 'unknown' };
  } catch {
    return { errorName: 'unknown' };
  }
}

/** Diagnostic callbacks never participate in model settlement or resource ownership. */
function notify({ sink, packet, failed }: { sink: ({ packet }: { packet: LoadDiagnosticPacket }) => unknown; packet: LoadDiagnosticPacket; failed: () => void }): void {
  try {
    const result = sink({ packet });
    if (result !== undefined) void Promise.resolve(result).catch(failed);
  } catch {
    failed();
  }
}

/** Small, host-owned records survive loss of the Worker and its final capture RPC. */
export function createLoadDiagnosticLedger({ owner }: { owner: ProductionLoadReceiptOwner }) {
  const events: LoadDiagnosticEvent[] = [];
  const reasons = new Set<LoadDiagnostics['incompleteReasons'][number]>();
  return {
    observe({ packet }: { packet: unknown }): void {
      if (events.length >= 512) {
        reasons.add('event-limit'); return;
      }
      try {
        const parsed = loadDiagnosticPacketSchema.safeParse(packet);
        if (!parsed.success || parsed.data.owner.runId !== owner.runId || parsed.data.owner.workerEpoch !== owner.workerEpoch) {
          reasons.add('invalid-event'); return;
        }
        const previous = events.findLast(event => event.loadOrdinal === parsed.data.event.loadOrdinal);
        if (parsed.data.event.sequence <= (previous?.sequence ?? 0)) {
          reasons.add('invalid-event'); return;
        }
        if (parsed.data.event.sequence !== (previous?.sequence ?? 0) + 1) reasons.add('invalid-event');
        events.push(parsed.data.event);
        for (const reason of parsed.data.incompleteReasons) reasons.add(reason);
      } catch {
        reasons.add('invalid-event');
      }
    },
    snapshot({ expectedLoadCount }: { expectedLoadCount: number }): LoadDiagnostics {
      const snapshotReasons = new Set(reasons);
      for (let ordinal = 1; ordinal <= Math.min(expectedLoadCount, 32); ordinal++) {
        if (!events.some(event => event.loadOrdinal === ordinal)) snapshotReasons.add('unobserved-load');
        else if (!events.some(event => event.loadOrdinal === ordinal && (event.kind === 'load-finished' || event.kind === 'load-failed'))) snapshotReasons.add('load-not-settled');
      }
      return { format: 'production-load-diagnostics-v1', owner: { ...owner }, limits: { maxEvents: 512, maxResources: 128 },
        byteAccounting: 'successful-allocation-request-sum-not-live-memory-or-gc',
        coverage: 'transformers-readResponse-and-session-entry-only-not-response-arrayBuffer-or-ort-internals',
        events: events.map(event => ({ ...event })), incompleteReasons: [...snapshotReasons] };
    },
  };
}

/** Worker-side scalar projection. Tokens identify reads; no body/buffer is retained. */
export function createLoadDiagnosticOperation({ owner, loadOrdinal, sink, resourceNames }: {
  owner: ProductionLoadReceiptOwner; loadOrdinal: number; sink: ({ packet }: { packet: LoadDiagnosticPacket }) => unknown;
  resourceNames: 'public-repository' | 'omit';
}) {
  let sequence = 0, candidateOrdinal = 0, readOrdinal = 0;
  let allocated = 0, returned = 0, activeReads = 0;
  let scope: 'active' | 'closed' = 'active';
  const reasons = new Set<LoadDiagnostics['incompleteReasons'][number]>();
  const tokens = new WeakMap<object, { readOrdinal: number; resource: string | undefined; candidateOrdinal: number; reading: boolean }>();
  function emit({ kind, details }: { kind: LoadDiagnosticEvent['kind']; details: Details }): void {
    if (sequence >= 512) return;
    if (sequence === 511) {
      reasons.add('event-limit'); kind = 'diagnostic-incomplete';
    }
    try {
      const event = loadDiagnosticEventSchema.safeParse({ loadOrdinal, sequence: ++sequence, candidateOrdinal, kind, ...details,
        candidateScopeAllocatedBytes: allocated, returnedReadBufferBytes: returned, activeReadCount: activeReads, scope });
      if (!event.success) return;
      notify({ sink, packet: { owner, event: event.data, incompleteReasons: [...reasons] }, failed: () => {
        reasons.add('transport-failed');
      } });
    } catch { /* Recording cannot alter Load. */ }
  }
  const operation = {
    emit,
    beginCandidate({ device, dtype, revision }: { device: 'webgpu' | 'wasm'; dtype: string; revision: string | undefined }): UpstreamLoadDiagnosticObserver {
      candidateOrdinal++; allocated = 0; returned = 0; activeReads = 0; scope = 'active';
      emit({ kind: 'candidate-start', details: { device, dtype, ...(revision !== undefined && /^(?:[a-f0-9]{40}|main)$/u.test(revision) ? { revision } : {}) } });
      const capturedOrdinal = candidateOrdinal;
      // eslint-disable-next-line local-rules-named-args/require-named-args -- Third-party bundle callback boundary.
      return (value: unknown) => {
        if (capturedOrdinal !== candidateOrdinal) {
          if (!reasons.has('invalid-event')) {
            reasons.add('invalid-event'); emit({ kind: 'diagnostic-incomplete', details: {} });
          }
          return;
        }
        operation.observeUpstream(value);
      };
    },
    closeCandidate() {
      scope = 'closed'; emit({ kind: 'candidate-finished', details: {} });
    },
    // The reviewed upstream adapter sends only a token and scalar diagnostics.
    // It captures this callback before awaiting, so late events keep their owner.
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Third-party bundle callback boundary.
    observeUpstream(value: unknown): void {
      if (sequence >= 512) return;
      try {
        if (typeof value !== 'object' || value === null) return;
        const raw = z.object({ token: z.object({}).strict(), kind: z.enum(['read', 'session']), resource: z.string().max(256).optional(),
          phase: z.enum(['allocation-attempt', 'allocation-succeeded', 'allocation-failed', 'read-start', 'read-returned', 'read-failed',
            'session-preparing', 'session-entering', 'session-fulfilled', 'session-rejected']), bytes: count, errorName: z.string().max(64).optional(),
        }).strict().safeParse(value);
        if (!raw.success) return;
        // Keep the original token identity, not Zod's cloned empty object.
        const token = Reflect.get(value, 'token') as object;
        let read = tokens.get(token);
        if (read === undefined) {
          if (readOrdinal >= 128) {
            if (!reasons.has('resource-limit')) {
              reasons.add('resource-limit'); emit({ kind: 'diagnostic-incomplete', details: {} });
            }
            return;
          }
          const path = resource.safeParse(raw.data.resource);
          if (raw.data.kind === 'read' && !path.success) return;
          read = { readOrdinal: ++readOrdinal, resource: path.success && resourceNames === 'public-repository' ? path.data : undefined, candidateOrdinal, reading: false };
          tokens.set(token, read);
        }
        if (read.candidateOrdinal !== candidateOrdinal) return;
        const { phase, bytes } = raw.data;
        switch (phase) {
        case 'allocation-succeeded': allocated = Math.min(Number.MAX_SAFE_INTEGER, allocated + bytes); break;
        case 'read-start':
          if (!read.reading) {
            read.reading = true; activeReads++;
          }
          break;
        case 'read-returned':
          returned = Math.min(Number.MAX_SAFE_INTEGER, returned + bytes);
          if (read.reading) {
            read.reading = false; activeReads--;
          }
          break;
        case 'read-failed':
          if (read.reading) {
            read.reading = false; activeReads--;
          }
          break;
        case 'allocation-attempt': case 'allocation-failed':
        case 'session-preparing': case 'session-entering': case 'session-fulfilled': case 'session-rejected': break;
        default: { const _ex: never = phase; throw new Error(`Unhandled diagnostic phase: ${_ex}`); }
        }
        const name = errorName.safeParse(raw.data.errorName);
        emit({ kind: phase, details: { resource: read.resource, readOrdinal: read.readOrdinal, requestedBytes: bytes,
          ...(raw.data.errorName === undefined ? {} : { errorName: name.success ? name.data : 'unknown' }) } });
      } catch { /* A malformed observation must not change the original exception. */ }
    },
  };
  return operation;
}

export const TEST_ONLY = {
};
