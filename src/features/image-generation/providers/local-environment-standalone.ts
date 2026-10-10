import { createDisabledImageLibrary } from '@/features/stable-diffusion-cpp-browser/library-standalone';
import type { createImageEngineClient as NativeEngineFactory } from '@/features/stable-diffusion-cpp-browser/inference/engine';
import type { inspectImageInventory as NativeInventory } from '@/features/stable-diffusion-cpp-browser/inventory-worker/client';
import type { useImageLibrary as NativeLibrary } from '@/features/stable-diffusion-cpp-browser/use-image-library';

export const rawConfiguration = { kind: 'unavailable', reason: 'standalone' };

export function initialProfile(): 'webgpu-wasm32-asyncify' {
  return 'webgpu-wasm32-asyncify';
}

export function supportsJspi(): boolean {
  return false;
}

export function supportsMemory64(): boolean {
  return false;
}

export const useImageLibrary: typeof NativeLibrary = () => createDisabledImageLibrary();

export const createImageEngineClient: typeof NativeEngineFactory = () => {
  throw new Error('Local image inference is not included in this build');
};

export const inspectImageInventory: typeof NativeInventory = async () => {
  throw new Error('Local model inspection is not included in this build');
};

export const TEST_ONLY = {
};
