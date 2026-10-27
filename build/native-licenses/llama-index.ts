import type { NativeLicenseIndex } from './index-types';

// A literal import keeps the actual installed JSON in TypeScript's program.
// Do not replace this with JSON.parse(...), an ambient *.json declaration, or as.
export async function importLlamaLicenseIndex(): Promise<NativeLicenseIndex> {
  const { default: index } = await import('llama-cpp-browser-core/llama-cpp/native-license-index.json', { with: { type: 'json' } });
  return index satisfies NativeLicenseIndex;
}

export const TEST_ONLY = {
};
