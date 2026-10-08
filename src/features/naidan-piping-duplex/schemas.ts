import { z } from 'zod';
import { MAX_OFFSET, SEGMENT_BYTES } from '@/features/naidan-piping-duplex/bytes';

const bitmap = z.instanceof(Uint8Array).refine(value => value.byteLength <= 8192);
const offset = z.bigint().min(0n).max(MAX_OFFSET);
const id = z.number().int().min(0).max(65535);

// Decode lengths before allocation; validate the complete external shape before semantic application.
export const snapshotSchema = z.strictObject({
  goaway: z.boolean(),
  finished: bitmap,
  reset: bitmap,
  states: z.array(z.strictObject({
    id,
    flags: z.number().int().min(0).max(3),
    rxNext: offset,
    rxLimit: offset,
    final: offset,
  })).max(32),
  data: z.array(z.strictObject({
    id,
    offset,
    bytes: z.instanceof(Uint8Array).refine(value => value.byteLength > 0 && value.byteLength <= SEGMENT_BYTES),
  })).max(2),
});

export const journalEnvelopeSchema = z.strictObject({
  role: z.union([z.literal(1), z.literal(2)]),
  count: z.number().int().min(0).max(16),
  attemptI: z.instanceof(Uint8Array).refine(value => value.byteLength === 32),
  attemptR: z.instanceof(Uint8Array).refine(value => value.byteLength === 32),
});

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
