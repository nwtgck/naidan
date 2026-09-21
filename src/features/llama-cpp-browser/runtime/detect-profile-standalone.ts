import { LlamaCppBrowserError, type LlamaCppProfile, type RuntimeOptions } from '@/features/llama-cpp-browser/types';
import { parseRuntimeOptions } from './profile-policy-standalone';
import { checkJspi, checkStorage, gpuUnavailableReason, memory64Probe, supportsMemory64, suspensionProbe } from './capability-probes';
import { profileCapabilitiesSchema, type ProfileCapabilities, type ProfileUnavailableReason } from './profile-capabilities';
import { decodeEmbeddedBrotli } from '@/features/file-protocol-standalone/embedded-binary';

export async function resolveRuntimeProfile({ profile }: { profile: RuntimeOptions['profile'] }): Promise<LlamaCppProfile> {
  parseRuntimeOptions({ options: { profile } });
  try {
    if (typeof WebAssembly === 'undefined') throw new Error('WebAssembly');
    const selected = (() => {
      switch (profile) {
      case 'auto': {
        // Validation can throw on older engines. Both outcomes mean the
        // embedded wasm32 runtime is the appropriate capability-based choice.
        let memory64 = false;
        try {
          memory64 = WebAssembly.validate(memory64Probe);
        } catch { /* No memory64 support. */ }
        return memory64 ? 'webgpu-wasm64-jspi' : 'webgpu-wasm32-jspi';
      }
      case 'webgpu-wasm64-jspi':
        if (!WebAssembly.validate(memory64Probe)) throw new Error('memory64');
        return profile;
      case 'webgpu-wasm32-jspi': return profile;
      case 'cpu-wasm32': case 'cpu-wasm64': case 'webgpu-wasm32-asyncify': throw new Error('Non-embedded profile');
      default: { const exhaustive: never = profile; throw new Error(`Unhandled profile: ${exhaustive}`); }
      }
    })();
    await checkJspi();
    if (await gpuUnavailableReason()) throw new Error('WebGPU');
    // Standalone intentionally ships only Brotli to reduce distribution size;
    // browser-side DecompressionStream('brotli') must remain standalone-only.
    // Hosted browser paths must not run this probe and retain gzip decoding.
    // Exercise a tiny known payload in the actual Worker, not User-Agent or
    // constructor presence. This also probes the integrity checker
    // without loading the multi-megabyte runtime chunk. The expected byte is 71.
    await decodeEmbeddedBrotli({
      base64: 'CwCARwM=', byteLength: 1,
      sha256: '333e0a1e27815d0ceee55c473fe3dc93d56c63e3bee2b3b4aee8eed6d70191a3',
    });
    await checkStorage();
    return selected;
  } catch {
    // Required-capability failures never select CPU or Asyncify. Initialization still
    // has the final say, including the pinned core's upstream version checks.
    throw new LlamaCppBrowserError({ code: 'unavailable' });
  }
}
/** Probe only browser capabilities in the inference Worker, before core/model loading. */
export async function probeRuntimeProfiles(): Promise<ProfileCapabilities> {
  let reason: ProfileUnavailableReason | undefined;
  const memory64 = supportsMemory64();
  try {
    reason = 'wasm';
    if (typeof WebAssembly === 'undefined') throw new Error('WebAssembly');
    reason = 'jspi'; await checkJspi();
    const gpuReason = await gpuUnavailableReason();
    if (gpuReason) {
      reason = gpuReason; throw new Error('WebGPU');
    }
    reason = 'brotli';
    await decodeEmbeddedBrotli({ base64: 'CwCARwM=', byteLength: 1,
      sha256: '333e0a1e27815d0ceee55c473fe3dc93d56c63e3bee2b3b4aee8eed6d70191a3' });
    reason = 'storage'; await checkStorage();
    reason = undefined;
  } catch { /* Return only a closed capability reason, never browser error text. */ }
  return profileCapabilitiesSchema.parse({
    recommended: reason ? undefined : memory64 ? 'webgpu-wasm64-jspi' : 'webgpu-wasm32-jspi',
    profiles: (['webgpu-wasm64-jspi', 'webgpu-wasm32-jspi'] as const).map(profile => {
      const failure = reason ?? (profile === 'webgpu-wasm64-jspi' && !memory64 ? 'memory64' : undefined);
      return failure ? { profile, status: 'unavailable', reason: failure } : { profile, status: 'available' };
    }),
  });
}
export const TEST_ONLY = {
  memory64Probe,
  suspensionProbe,
  checkStorage,
};
