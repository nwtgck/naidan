import { z } from 'zod';
import { normalizeTransformersJsProductionModelId } from '@/features/transformers-js/production-routing';

const modelIdSchema = z.string().min(3).max(256).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
const repositoryPathSchema = z.string().min(1).max(512).refine(path => !path.startsWith('/') && !path.includes('\\') && !path.split('/').some(part => part === '.' || part === '..') && ![...path].some(character => character.charCodeAt(0) < 32));
const revisionOptionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('provided'), value: z.string().min(1).max(128) }).strict(),
  z.object({ status: z.literal('omitted') }).strict(),
]);

export function productionLoadReceiptRevisionOption({ option }: { option: z.infer<typeof revisionOptionSchema> }): string | undefined {
  switch (option.status) {
  case 'provided': return option.value;
  case 'omitted': return undefined;
  default: { const exhaustive: never = option; throw new Error('Unknown Load revision option: ' + exhaustive); }
  }
}

export const productionLoadReceiptSchema = z.object({
  format: z.literal('production-offline-load-receipt-v1'),
  modelId: modelIdSchema,
  loaderRevisionOption: revisionOptionSchema,
  autoClass: z.enum(['AutoModelForCausalLM', 'AutoModelForImageTextToText']),
  processor: z.enum(['tokenizer', 'gemma4-processor', 'qwen3_5-processor']),
  candidate: z.object({ device: z.enum(['webgpu', 'wasm']), dtype: z.enum(['q4f16', 'q4']) }).strict(),
  plannedRequiredPaths: z.array(repositoryPathSchema).min(1).max(256),
  cacheLookup: z.object({
    source: z.literal('read-only-opfs-scoped-match'),
    revision: z.string().min(1).max(128),
    hitPaths: z.array(repositoryPathSchema).min(1).max(256),
  }).strict(),
  completion: z.literal('model-session-and-tokenizer-processor-ready'),
  resourceHealth: z.literal('healthy-after-close'),
  accessBoundary: z.literal('production-offline-read-only'),
  limitations: z.object({ wholeFileProvenance: z.literal('not-verified'), allPlannedBodiesConsumed: z.literal('not-certified') }).strict(),
}).strict().superRefine((receipt, context) => {
  const revision = productionLoadReceiptRevisionOption({ option: receipt.loaderRevisionOption }) ?? 'main';
  if (revision !== receipt.cacheLookup.revision || new Set(receipt.plannedRequiredPaths).size !== receipt.plannedRequiredPaths.length
    || new Set(receipt.cacheLookup.hitPaths).size !== receipt.cacheLookup.hitPaths.length
    || receipt.plannedRequiredPaths.some(path => !receipt.cacheLookup.hitPaths.includes(path))) {
    context.addIssue({ code: 'custom', message: 'Inconsistent Production Load receipt resources' });
  }
});
export type ProductionLoadReceipt = z.infer<typeof productionLoadReceiptSchema>;

function receiptDataSnapshot({ value, depth, budget }: { value: unknown; depth: number; budget: { remaining: number } }): unknown {
  if (--budget.remaining < 0 || depth > 8) throw new Error('Load receipt exceeds its observation budget');
  if (value === undefined || value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string' && value.length <= 512) return value;
  if (typeof value !== 'object' || value === null) throw new Error('Invalid Load receipt value');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    const length: unknown = descriptors.length?.value;
    if (typeof length !== 'number' || length > 256 || Object.keys(descriptors).length !== length + 1) throw new Error('Invalid Load receipt array');
    return Array.from({ length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) throw new Error('Invalid Load receipt array member');
      return receiptDataSnapshot({ value: descriptor.value, depth: depth + 1, budget });
    });
  }
  if (Reflect.ownKeys(descriptors).length > 20 || Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')) throw new Error('Invalid Load receipt object');
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => {
    if (!Object.hasOwn(descriptor, 'value')) throw new Error('Load receipt accessors are not observed');
    return [key, receiptDataSnapshot({ value: descriptor.value, depth: depth + 1, budget })];
  }));
}

/** Legacy Load responses still work; only a validated receipt can certify identity. */
export function readProductionLoadResultReceipt({ value, modelId, revision }: { value: unknown; modelId: string; revision: string | undefined }): ProductionLoadReceipt | undefined {
  let snapshot: unknown;
  try {
    snapshot = receiptDataSnapshot({ value, depth: 0, budget: { remaining: 1024 } });
  } catch {
    return undefined;
  }
  const parsed = z.object({ device: z.string(), dtype: z.enum(['q4', 'q4f16']).optional(), receipt: productionLoadReceiptSchema.optional() }).strict().safeParse(snapshot);
  if (!parsed.success || parsed.data.receipt === undefined) return undefined;
  const { receipt, device, dtype } = parsed.data;
  const receiptRevision = productionLoadReceiptRevisionOption({ option: receipt.loaderRevisionOption });
  if (receipt.modelId !== normalizeTransformersJsProductionModelId({ modelId }) || receiptRevision !== revision
    || receipt.candidate.device !== device || receipt.candidate.dtype !== dtype) return undefined;
  return receipt;
}

/** Observe existing cache matches without I/O or runtime decision authority. */
export function createProductionLoadReceiptRecorder({ modelId, revision }: { modelId: string; revision: string | undefined }) {
  const cleanModelId = normalizeTransformersJsProductionModelId({ modelId });
  const prefix = `models/huggingface.co/${cleanModelId.split('/').map(part => encodeURIComponent(part)).join('/')}/resolve/`;
  const hits = new Set<string>();
  let observedRevision: string | undefined;
  let refused = cleanModelId.startsWith('user/') || cleanModelId.startsWith('local/');
  return {
    observe({ resourceKey, result }: { resourceKey: string; result: 'hit' | 'miss' }) {
      if (refused || result === 'miss') return;
      try {
        if (!resourceKey.startsWith(prefix)) {
          refused = true; return;
        }
        const remainder = resourceKey.slice(prefix.length);
        const separator = remainder.indexOf('/');
        const actualRevision = remainder.slice(0, separator);
        const path = remainder.slice(separator + 1);
        if (separator < 1 || actualRevision.length > 128 || !repositoryPathSchema.safeParse(path).success
          || (observedRevision !== undefined && observedRevision !== actualRevision) || hits.size >= 256 && !hits.has(path)) {
          refused = true; return;
        }
        observedRevision = actualRevision;
        hits.add(path);
      } catch {
        refused = true;
      }
    },
    finish({ autoClass, processor, candidate, plannedRequiredPaths }: Pick<ProductionLoadReceipt, 'autoClass' | 'processor' | 'candidate' | 'plannedRequiredPaths'>): ProductionLoadReceipt | undefined {
      if (refused || observedRevision === undefined) return undefined;
      const parsed = productionLoadReceiptSchema.safeParse({
        format: 'production-offline-load-receipt-v1', modelId: cleanModelId,
        loaderRevisionOption: revision === undefined ? { status: 'omitted' } : { status: 'provided', value: revision },
        autoClass, processor, candidate, plannedRequiredPaths: [...new Set(plannedRequiredPaths)].sort(),
        cacheLookup: { source: 'read-only-opfs-scoped-match', revision: observedRevision, hitPaths: [...hits].sort() },
        completion: 'model-session-and-tokenizer-processor-ready', resourceHealth: 'healthy-after-close',
        accessBoundary: 'production-offline-read-only',
        limitations: { wholeFileProvenance: 'not-verified', allPlannedBodiesConsumed: 'not-certified' },
      });
      return parsed.success ? parsed.data : undefined;
    },
  };
}

export const TEST_ONLY = {
};
