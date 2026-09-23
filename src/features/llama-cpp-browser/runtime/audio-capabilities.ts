import { z } from 'zod';
import rawSchema from 'llama-cpp-browser-core/api/schema.mjs';

export const AUDIO_LANGUAGE_AUTO_QUERY = 'mtmd_helper_gen_audio_supports_language_auto';
/** Artifact-level availability only. The worker also checks the loaded pipeline.
 * The schema hash is checked against Wasm by attachCore, so stale cached binaries
 * cannot silently advertise a capability from a newer JavaScript package. */
export function audioRuntimeCapabilities({ schema }: { schema: unknown }): { languageAuto: boolean } {
  const parsed = z.object({ functions: z.array(z.object({
    name: z.string(), returnKind: z.string(), parameters: z.array(z.object({ kind: z.string() })),
  })) }).safeParse(schema);
  return { languageAuto: parsed.success && parsed.data.functions.some(fn => fn.name === AUDIO_LANGUAGE_AUTO_QUERY
    && fn.returnKind === 'boolean' && fn.parameters.length === 1 && fn.parameters[0]?.kind === 'pointer') };
}
export const nativeAudioCapabilities = audioRuntimeCapabilities({ schema: rawSchema });
export const TEST_ONLY = {
};
