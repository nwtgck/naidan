import type { NativeLicenseIndex } from './index-types.ts';

// Selected only for an installed hosted speech runtime. The literal import
// checks the package's actual JSON rather than a separate declaration.
export async function importSpeechLicenseIndex(): Promise<NativeLicenseIndex> {
  const { default: index } = await import('speech-cpp-browser-core/speech-cpp/native-license-index.json', { with: { type: 'json' } });
  return index satisfies NativeLicenseIndex;
}

export const TEST_ONLY = {
};
