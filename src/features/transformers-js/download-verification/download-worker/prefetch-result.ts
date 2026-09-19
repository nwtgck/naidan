import { z } from 'zod';
import type { TransformersJsPrefetchResult } from '@/features/transformers-js/types';
import { downloadFileTimingSchema, downloadSourceTimingSchema, parseDownloadTiming } from '@/features/transformers-js/download-timing';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const errorCause = z.object({ name: z.string(), message: z.string(), stack: z.string().optional(), thrownType: z.string().optional(), serializedOriginalThrownValue: z.string().optional() });
const error = errorCause.extend({ cause: errorCause.optional(), causeChain: z.array(errorCause).optional() });
// Unknown advisory fields are deliberately outside core I/O validation.
const core = z.object({
  requestedCount: count, cachedCount: count, downloadedCount: count, failedCount: count, complete: z.boolean(),
  timing: z.unknown().optional(),
  files: z.array(z.union([
    z.object({ status: z.enum(['cached', 'downloaded']), url: z.string(), path: z.string(), byteLength: count, expectedByteLength: count.optional(), timing: z.unknown().optional() }),
    z.object({ status: z.literal('failed'), url: z.string(), path: z.string().optional(), failureStage: z.enum(['resolve-path', 'cache-check', 'fetch', 'response-status', 'write', 'verification']), httpStatus: count.optional(), error, transferObservation: z.object({ receivedBytes: count, expectedBytes: count.optional() }).optional(), timing: z.unknown().optional() }),
  ])),
});

export function parsePrefetchResult({ value }: { value: unknown }): TransformersJsPrefetchResult {
  const result = core.parse(value);
  const { files, timing, ...rest } = result;
  return {
    ...rest,
    ...(timing === undefined ? {} : { timing: parseDownloadTiming({ schema: downloadSourceTimingSchema, value: timing }) ?? { version: 1, status: 'unavailable' } }),
    files: files.map(file => {
      const { timing: fileTiming, ...fileCore } = file;
      const parsed = parseDownloadTiming({ schema: downloadFileTimingSchema, value: fileTiming });
      // An invalid duration does not erase a independently valid method, but an
      // unknown method must not be invented as the legacy staging-copy route.
      const saveMethod = parseDownloadTiming({ schema: z.object({ saveMethod: downloadFileTimingSchema.shape.saveMethod }), value: fileTiming })?.saveMethod;
      const contradictory = file.status !== 'downloaded' && parsed?.eofToVerifiedMs !== undefined
        || file.status === 'cached' && (parsed?.streamMs !== undefined || parsed?.responseWaitMs !== undefined)
        || file.status === 'downloaded' && parsed?.status === 'measured' && parsed.eofToVerifiedMs === undefined;
      const observation = fileTiming === undefined ? {} : { timing: !contradictory && parsed !== undefined ? parsed : saveMethod === undefined ? undefined : { version: 1 as const, status: 'unavailable' as const, saveMethod } };
      switch (fileCore.status) {
      case 'failed': {
        const { transferObservation, ...failedCore } = fileCore;
        return { ...failedCore, path: failedCore.path, httpStatus: failedCore.httpStatus, ...(transferObservation === undefined ? {} : { transferObservation: { receivedBytes: transferObservation.receivedBytes, expectedBytes: transferObservation.expectedBytes } }), ...observation };
      }
      case 'cached':
      case 'downloaded':
        return { ...fileCore, expectedByteLength: fileCore.expectedByteLength, ...observation };
      default: {
        const exhaustive: never = fileCore;
        throw new Error(`Unhandled prefetch result: ${String(exhaustive)}`);
      }
      }
    }),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
