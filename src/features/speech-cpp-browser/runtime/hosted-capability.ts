import type { SpeechConfiguration } from '@/features/speech-cpp-browser/artifacts';
import type { SpeechUnavailableReason } from '@/features/speech-cpp-browser/types';

export function speechHostedUnavailableReason({ configuration }: {
  configuration: SpeechConfiguration;
}): SpeechUnavailableReason | undefined {
  switch (configuration.kind) {
  case 'unavailable': return configuration.reason;
  case 'available': break;
  default: {
    const exhaustive: never = configuration;
    throw new Error(String(exhaustive));
  }
  }
  if (typeof Worker === 'undefined') {
    return 'worker_unavailable';
  }
  if (typeof navigator === 'undefined' || !('gpu' in navigator) || navigator.gpu === undefined) {
    return 'webgpu_unavailable';
  }
  if (configuration.artifact.profile === 'webgpu-wasm64-jspi' && (typeof WebAssembly === 'undefined'
    || !WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 1])))) {
    return 'memory64_unavailable';
  }
  const wasm = typeof WebAssembly === 'undefined' ? undefined : WebAssembly;
  if (wasm === undefined || !('Suspending' in wasm) || typeof wasm.Suspending !== 'function'
    || !('promising' in wasm) || typeof wasm.promising !== 'function') {
    return 'jspi_unavailable';
  }
  return undefined;
}

export const TEST_ONLY = {
};
