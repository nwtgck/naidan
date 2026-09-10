import { z } from 'zod';
import { normalizeTransformersJsProductionModelId } from '@/features/transformers-js/production-routing';

const missingReasonSchema = z.enum(['no-completed-load', 'load-in-progress', 'runtime-cleared', 'untracked-load-path', 'overlapping-lifecycle', 'identity-limit', 'recording-failed']);
export const productionLoadIdentitySchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    workerLoadOrdinal: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    requestedModelId: z.string().min(1).max(256),
    requestedRevision: z.discriminatedUnion('status', [
      z.object({ status: z.literal('provided'), value: z.string().min(1).max(128) }).strict(),
      z.object({ status: z.literal('omitted') }).strict(),
    ]),
    cleanModelId: z.string().min(1).max(256),
    autoClass: z.enum(['AutoModelForCausalLM', 'AutoModelForImageTextToText']),
    processor: z.enum(['tokenizer', 'gemma4-processor', 'qwen3_5-processor']),
    selectedCandidate: z.object({ device: z.enum(['webgpu', 'wasm']), dtype: z.enum(['q4f16', 'q4']) }).strict(),
    resolvedRevision: z.object({ status: z.literal('not-observed') }).strict(),
    sessionExecutionProvider: z.object({ status: z.literal('not-observed') }).strict(),
  }).strict().refine(value => normalizeTransformersJsProductionModelId({ modelId: value.requestedModelId }) === value.cleanModelId, 'Load model identity mismatch'),
  z.object({ status: z.literal('not-observed'), reason: missingReasonSchema }).strict(),
]);
export type ProductionLoadIdentity = z.infer<typeof productionLoadIdentitySchema>;

function missing({ reason }: { reason: z.infer<typeof missingReasonSchema> }): ProductionLoadIdentity {
  return Object.freeze({ status: 'not-observed', reason });
}

function ownValue({ value, key }: { value: unknown; key: string }): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

/** Freeze only the known, already copied primitive DTO, never a live route. */
export function freezeProductionLoadIdentity({ identity }: { identity: ProductionLoadIdentity }): ProductionLoadIdentity {
  switch (identity.status) {
  case 'not-observed': return Object.freeze(identity);
  case 'ready':
    Object.freeze(identity.requestedRevision);
    Object.freeze(identity.selectedCandidate);
    Object.freeze(identity.resolvedRevision);
    Object.freeze(identity.sessionExecutionProvider);
    return Object.freeze(identity);
  default: { const _ex: never = identity; throw new Error(String(_ex)); }
  }
}

/** One small Worker-local diagnostic slot, never a runtime control input. */
export function createProductionLoadIdentityTracker() {
  let identity = missing({ reason: 'no-completed-load' });
  let ordinal = 0;
  let activeCount = 0;
  let clearEpoch = 0;
  return {
    beginLoad({ source, modelId, revision }: { source: 'ordinary' | 'non-ordinary'; modelId: string; revision: string | undefined }) {
      ordinal += 1;
      const ownOrdinal = ordinal;
      const ownClearEpoch = clearEpoch;
      const uncontended = activeCount === 0;
      activeCount += 1;
      const bounded = typeof modelId === 'string' && modelId.length > 0 && modelId.length <= 256
        && (revision === undefined || (typeof revision === 'string' && revision.length > 0 && revision.length <= 128))
        && Number.isSafeInteger(ordinal);
      switch (source) {
      case 'ordinary': identity = missing({ reason: uncontended ? 'load-in-progress' : 'overlapping-lifecycle' }); break;
      case 'non-ordinary': identity = missing({ reason: uncontended ? 'untracked-load-path' : 'overlapping-lifecycle' }); break;
      default: { const _ex: never = source; throw new Error(String(_ex)); }
      }
      let finished = false;
      return {
        clear() {
          // Cleanup belonging to this Load invalidates old readiness, but may
          // still be followed by its successful candidate fallback. External
          // unload uses the tracker clear instead and invalidates this token.
          if (!finished && ordinal === ownOrdinal && clearEpoch === ownClearEpoch && uncontended && activeCount === 1) {
            identity = missing({ reason: 'runtime-cleared' });
          }
        },
        finish({ route }: { route: unknown }) {
          if (finished) return;
          finished = true;
          activeCount -= 1;
          if (ordinal !== ownOrdinal || clearEpoch !== ownClearEpoch || !uncontended || activeCount !== 0) return;
          switch (source) {
          case 'ordinary': break;
          case 'non-ordinary': identity = missing({ reason: 'untracked-load-path' }); return;
          default: { const _ex: never = source; throw new Error(String(_ex)); }
          }
          if (route === undefined) {
            identity = missing({ reason: 'no-completed-load' }); return;
          }
          if (!bounded) {
            identity = missing({ reason: 'identity-limit' }); return;
          }
          try {
            const candidate = ownValue({ value: route, key: 'candidate' });
            const parsed = productionLoadIdentitySchema.safeParse({
              status: 'ready', workerLoadOrdinal: ownOrdinal, requestedModelId: modelId,
              requestedRevision: revision === undefined ? { status: 'omitted' } : { status: 'provided', value: revision },
              cleanModelId: ownValue({ value: route, key: 'cleanModelId' }),
              autoClass: ownValue({ value: route, key: 'autoClass' }),
              processor: ownValue({ value: route, key: 'processor' }),
              selectedCandidate: { device: ownValue({ value: candidate, key: 'device' }), dtype: ownValue({ value: candidate, key: 'dtype' }) },
              // These are successful loader options, not an ORT session query
              // or a hash of the model files actually consumed.
              resolvedRevision: { status: 'not-observed' }, sessionExecutionProvider: { status: 'not-observed' },
            });
            identity = parsed.success ? freezeProductionLoadIdentity({ identity: parsed.data }) : missing({ reason: 'recording-failed' });
          } catch {
            identity = missing({ reason: 'recording-failed' });
          }
        },
      };
    },
    clear() {
      clearEpoch += 1;
      identity = missing({ reason: 'runtime-cleared' });
    },
    snapshot(): ProductionLoadIdentity {
      return identity;
    },
  };
}

export const TEST_ONLY = {
};
