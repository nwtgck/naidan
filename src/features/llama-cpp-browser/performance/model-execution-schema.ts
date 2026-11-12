import { z } from 'zod';

/** Evidence of the selected execution implementation, never inferred from a
 * model name or the presence of a registered definition. Missing means unknown. */
export const modelExecutionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('nativeArchitecture') }).strict(),
  z.object({
    kind: z.literal('registeredModelGraph'),
    registrationId: z.string().min(1).max(128),
    label: z.string().min(1).max(120),
    architecture: z.string().min(1).max(128),
    format: z.string().min(1).max(128),
    definitionSha256: z.string().regex(/^[a-f0-9]{64}$/),
    nativeExtensionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
]);
export type ModelExecution = z.infer<typeof modelExecutionSchema>;
export const registeredGraphTimingSchema = z.object({
  builds: z.number().int().nonnegative(),
  reuseHits: z.number().int().nonnegative(),
  graphBuildMs: z.number().finite().nonnegative(),
  allocationMs: z.number().finite().nonnegative(),
  inputMs: z.number().finite().nonnegative(),
  computeMs: z.number().finite().nonnegative(),
  readbackMs: z.number().finite().nonnegative(),
}).strict();
export const TEST_ONLY = {
};
