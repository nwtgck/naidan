import { bindNativeChat } from './chat-bindings';
import { LlamaCppBrowserError, type LlamaCppProfile } from '@/features/llama-cpp-browser/types';
import type { CoreModuleOptions } from './artifacts';
import { decodeEmbeddedBrotli } from '@/features/file-protocol-standalone/embedded-binary';

function embeddedProfile({ profile, baseURL }: { profile: LlamaCppProfile, baseURL: URL | string | undefined }) {
  if (baseURL !== undefined) throw new LlamaCppBrowserError({ code: 'unavailable' });
  switch (profile) {
  case 'webgpu-wasm64-jspi': case 'webgpu-wasm32-jspi': return profile;
  case 'cpu-wasm32': case 'cpu-wasm64': case 'webgpu-wasm32-asyncify': throw new LlamaCppBrowserError({ code: 'unavailable' });
  default: { const exhaustive: never = profile; throw new Error(`Unhandled profile: ${exhaustive}`); }
  }
}
export async function loadWasmBinary({ profile, assetBaseURL }: { profile: LlamaCppProfile, assetBaseURL: string | undefined }): Promise<Uint8Array> {
  const embedded = embeddedProfile({ profile, baseURL: assetBaseURL });
  // Both runtimes stay lazy; only the selected profile is decoded in the Worker.
  const { base64, byteLength, sha256 } = await (async () => {
    switch (embedded) {
    case 'webgpu-wasm32-jspi': return import('virtual:file-protocol-standalone/binary/llama-cpp-browser-wasm32-jspi');
    case 'webgpu-wasm64-jspi': return import('virtual:file-protocol-standalone/binary/llama-cpp-browser');
    default: { const exhaustive: never = embedded; throw new Error(`Unhandled profile: ${exhaustive}`); }
    }
  })();
  return decodeEmbeddedBrotli({ base64, byteLength, sha256 });
}
export async function loadCoreModule({ profile, baseURL, moduleOptions }: {
  profile: LlamaCppProfile, baseURL: URL | string | undefined, moduleOptions: CoreModuleOptions,
}) {
  const embedded = embeddedProfile({ profile, baseURL });
  // The version-bound build adapter requires wasmBinary and forbids external acquisition.
  switch (embedded) {
  case 'webgpu-wasm32-jspi': {
    const { default: factory } = await import('virtual:llama-cpp-browser-core/webgpu-wasm32-jspi');
    const module = await factory(moduleOptions);
    return { module, chat: bindNativeChat({ native: module }) };
  }
  case 'webgpu-wasm64-jspi': {
    const { default: factory } = await import('virtual:llama-cpp-browser-core/webgpu-wasm64-jspi');
    const module = await factory(moduleOptions);
    return { module, chat: bindNativeChat({ native: module }) };
  }
  default: { const exhaustive: never = embedded; throw new Error(`Unhandled profile: ${exhaustive}`); }
  }
}
export const TEST_ONLY = {
};
