import type { NativeLicenseIndex } from './index-types';

// Invoked only for an available installed hosted runtime. Keeping the import
// inside the function preserves standalone and the absent-image-package path.
export async function importImageLicenseIndex(): Promise<NativeLicenseIndex> {
  const { default: index } = await import('stable-diffusion-cpp-browser-core/stable-diffusion-cpp/native-license-index.json', { with: { type: 'json' } });
  return index satisfies NativeLicenseIndex;
}

export const TEST_ONLY = {
};
