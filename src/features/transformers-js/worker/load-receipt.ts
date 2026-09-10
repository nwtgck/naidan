import { z } from 'zod';
import { productionLoadReceiptSchema, type ProductionLoadReceipt } from '@/features/transformers-js/runtime/production-load-receipt';

export const productionLoadReceiptOwnerSchema = z.object({
  runId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/u), workerEpoch: z.number().int().min(1).max(8),
}).strict();
export type ProductionLoadReceiptOwner = z.infer<typeof productionLoadReceiptOwnerSchema>;
export const productionLoadObservationSchema = z.object({
  format: z.literal('production-load-observation-v1'), owner: productionLoadReceiptOwnerSchema,
  loadOrdinal: z.number().int().positive().safe(),
  outcome: z.discriminatedUnion('status', [
    z.object({ status: z.literal('accepted'), receipt: productionLoadReceiptSchema }).strict(),
    z.object({ status: z.enum(['loading', 'failed', 'cleared', 'not-recorded']) }).strict(),
  ]),
}).strict();
export type ProductionLoadObservation = z.infer<typeof productionLoadObservationSchema>;

/** A Worker-local observation slot; never a Load control or persisted state. */
export function createProductionLoadReceiptSlot() {
  let ordinal = 0;
  let generation = 0;
  let active = 0;
  let observation: ProductionLoadObservation | undefined;
  return {
    begin({ owner }: { owner: unknown }) {
      ordinal++;
      generation++;
      const token = generation;
      const parsed = (() => {
        try {
          if (typeof owner !== 'object' || owner === null) return undefined;
          const descriptors = Object.getOwnPropertyDescriptors(owner);
          if (Reflect.ownKeys(descriptors).length !== 2 || !Object.hasOwn(descriptors.runId ?? {}, 'value') || !Object.hasOwn(descriptors.workerEpoch ?? {}, 'value')) return undefined;
          return productionLoadReceiptOwnerSchema.safeParse({ runId: descriptors.runId?.value, workerEpoch: descriptors.workerEpoch?.value });
        } catch {
          return undefined;
        }
      })();
      active++;
      observation = parsed?.success && active === 1 ? {
        format: 'production-load-observation-v1', owner: parsed.data, loadOrdinal: ordinal, outcome: { status: 'loading' },
      } : undefined;
      let finished = false;
      return {
        finish({ receipt }: { receipt: ProductionLoadReceipt | undefined }) {
          if (finished) return;
          finished = true;
          active--;
          if (token !== generation || active !== 0 || observation === undefined) return;
          observation = { ...observation, outcome: receipt === undefined ? { status: 'not-recorded' } : { status: 'accepted', receipt } };
        },
        fail() {
          if (finished) return;
          finished = true;
          active--;
          if (token === generation && active === 0 && observation !== undefined) observation = { ...observation, outcome: { status: 'failed' } };
        },
      };
    },
    clear() {
      generation++;
      if (observation !== undefined) observation = { ...observation, outcome: { status: 'cleared' } };
    },
    snapshot({ owner }: { owner: ProductionLoadReceiptOwner }): ProductionLoadObservation | undefined {
      if (observation === undefined || observation.owner.runId !== owner.runId || observation.owner.workerEpoch !== owner.workerEpoch) return undefined;
      return productionLoadObservationSchema.parse(observation);
    },
  };
}

export const TEST_ONLY = {
};
