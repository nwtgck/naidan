import { bindNativeChat } from './chat-bindings';
import { LlamaCppBrowserError, type LlamaCppProfile } from '@/features/llama-cpp-browser/types';

export type CoreModuleOptions = {
  wasmBinary: Uint8Array;
  // Consumed by Naidan's build adapter, not an upstream Emscripten option.
  naidanNavigator?: Pick<Navigator, 'gpu'>;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Emscripten logging callback ABI.
  print: (message: unknown) => void;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Emscripten logging callback ABI.
  printErr: (message: unknown) => void;
};

export async function loadWasmBinary({ profile, assetBaseURL }: { profile: LlamaCppProfile, assetBaseURL: string | undefined }): Promise<Uint8Array> {
  if (assetBaseURL === undefined) throw new LlamaCppBrowserError({ code: 'runtime-error' });
  const response = await fetch(new URL(`${profile}/core.wasm.gz`, assetBaseURL));
  if (!response.ok || !response.body) throw new LlamaCppBrowserError({ code: 'runtime-error' });
  return new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

export async function loadCoreModule({ profile, baseURL, moduleOptions }: {
  profile: LlamaCppProfile, baseURL: URL | string | undefined, moduleOptions: CoreModuleOptions,
}) {
  if (baseURL === undefined) throw new LlamaCppBrowserError({ code: 'runtime-error' });
  switch (profile) {
  case 'cpu-wasm32': {
    const module = await (await import('virtual:llama-cpp-browser-core/cpu-wasm32')).default(moduleOptions);
    return { module, chat: bindNativeChat({ native: module }) };
  }
  case 'cpu-wasm64': {
    const module = await (await import('virtual:llama-cpp-browser-core/cpu-wasm64')).default(moduleOptions);
    return { module, chat: bindNativeChat({ native: module }) };
  }
  case 'webgpu-wasm32-asyncify': {
    const module = await (await import('virtual:llama-cpp-browser-core/webgpu-wasm32-asyncify')).default(moduleOptions);
    return { module, chat: bindNativeChat({ native: module }) };
  }
  case 'webgpu-wasm32-jspi': {
    const module = await (await import('virtual:llama-cpp-browser-core/webgpu-wasm32-jspi')).default(moduleOptions);
    return { module, chat: bindNativeChat({ native: module }) };
  }
  case 'webgpu-wasm64-jspi': {
    const module = await (await import('virtual:llama-cpp-browser-core/webgpu-wasm64-jspi')).default(moduleOptions);
    return { module, chat: bindNativeChat({ native: module }) };
  }
  default: { const exhaustive: never = profile; throw new Error(`Unhandled profile: ${exhaustive}`); }
  }
}
export const TEST_ONLY = {
};
