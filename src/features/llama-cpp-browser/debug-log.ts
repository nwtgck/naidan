import { z } from 'zod';

const diagnosticSchema = z.object({
  event: z.enum(['import-start', 'import-complete', 'runtime-ready', 'load-complete',
    'generation-start', 'generation-complete', 'cancelled', 'released', 'failed']),
  elapsedMs: z.number().finite().nonnegative().optional(),
  bytes: z.number().finite().nonnegative().optional(),
  tokens: z.number().int().nonnegative().optional(),
  profile: z.enum(['cpu-wasm32', 'cpu-wasm64', 'webgpu-wasm64-jspi']).optional(),
}).strict();
/** Allowlisted fields only: never forward native logs, errors, names or chat data. */
export function logDiagnostic({ diagnostic }: { diagnostic: z.infer<typeof diagnosticSchema> }): void {
  const safe = diagnosticSchema.safeParse(diagnostic);
  if (safe.success) console.debug('[llama-cpp-browser]', safe.data);
}
export const TEST_ONLY = {
};
