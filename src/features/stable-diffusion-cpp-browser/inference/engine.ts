import { createImageClient } from '@/features/stable-diffusion-cpp-browser/worker/client';
import { createOwnedImageEngine } from './owned-engine';
import type { ImageClient } from '@/features/stable-diffusion-cpp-browser/worker/types';

// Construction is lazy: importing this facade never creates a Worker or probes
// storage. All consumers share ownership rather than sharing raw cancel().
const engine = createOwnedImageEngine({ createClient: createImageClient });

export function createImageEngineClient({ onReleased }: {
  onReleased: (() => void) | undefined,
}): ImageClient {
  return engine.createOwner({ onReleased });
}

export const TEST_ONLY = {
};
