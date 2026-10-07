// Only this facade may pull native model management and inference into the
// common workspace. The standalone build substitutes an unavailable local
// provider while retaining the remote caller, editing and persistence UI.
export { default as rawConfiguration } from 'virtual:stable-diffusion-cpp-browser/config';
export { createImageEngineClient } from '@/features/stable-diffusion-cpp-browser/inference/engine';
export { initialProfile, supportsJspi, supportsMemory64 } from '@/features/stable-diffusion-cpp-browser/capabilities';
export { useImageLibrary } from '@/features/stable-diffusion-cpp-browser/use-image-library';
export { inspectImageInventory } from '@/features/stable-diffusion-cpp-browser/inventory-worker/client';
export const TEST_ONLY = {
};
