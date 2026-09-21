import { bindNativeChat } from './chat-bindings';
import { LlamaCppBrowserError, type LlamaCppProfile } from '@/features/llama-cpp-browser/types';
import type { CoreModuleOptions } from './artifacts';
import { decodeEmbeddedBrotli } from '@/features/file-protocol-standalone/embedded-binary';

function assertEmbeddedSource({ profile, baseURL }: { profile: LlamaCppProfile, baseURL: URL | string | undefined }): void {
  if (profile !== 'webgpu-wasm64-jspi' || baseURL !== undefined) throw new LlamaCppBrowserError({ code: 'unavailable' });
}
export async function loadWasmBinary({ profile, assetBaseURL }: { profile: LlamaCppProfile, assetBaseURL: string | undefined }): Promise<Uint8Array> {
  assertEmbeddedSource({ profile, baseURL: assetBaseURL });
  const { base64, byteLength, sha256 } = await import('virtual:file-protocol-standalone/binary/llama-cpp-browser');
  return decodeEmbeddedBrotli({ base64, byteLength, sha256 });
}
export async function loadCoreModule({ profile, baseURL, moduleOptions }: {
  profile: LlamaCppProfile, baseURL: URL | string | undefined, moduleOptions: CoreModuleOptions,
}) {
  assertEmbeddedSource({ profile, baseURL });
  const { default: factory } = await import('virtual:llama-cpp-browser-core/webgpu-wasm64-jspi');
  // The version-bound build adapter requires wasmBinary and forbids external acquisition.
  const module = await factory(moduleOptions);
  return { module, chat: bindNativeChat({ native: module }) };
}
export const TEST_ONLY = {
};
