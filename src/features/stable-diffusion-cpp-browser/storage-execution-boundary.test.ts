import { describe, expect, it } from 'vitest';
import { MemoryStorageProvider } from '@/00-storage/service/memory-storage';
import { DEFAULT_SETTINGS, type BrowserImageGenerationSettings } from '@/01-models/types';
import { modelFileSchema, parametersSchema } from './types';
import { ggufFile, parametersFixture } from './test-fixtures';

async function roundtripPreferences({ preferences }: { preferences: BrowserImageGenerationSettings }) {
  const provider = new MemoryStorageProvider();
  await provider.saveSettings({
    settings: {
      ...DEFAULT_SETTINGS,
      storageType: 'local',
      endpoint: { type: 'openai', url: '' },
      experimental: { ...DEFAULT_SETTINGS.experimental, browserImageGeneration: preferences },
    },
  });
  const restored = (await provider.loadSettings())?.experimental?.browserImageGeneration;
  if (!restored) throw new Error('Missing restored preferences');
  return restored;
}

describe('persisted preferences versus execution boundary', () => {
  it.each([{ width: 4096 }, { width: 255 }, { seed: '' }, { seed: 'abc' }, { seed: '9223372036854775808' }])('loads preferences without authorizing unsupported execution: %j', async preferences => {
    const restored = await roundtripPreferences({ preferences });
    expect(restored).toMatchObject(preferences);
    expect(parametersSchema.safeParse({ ...parametersFixture(), ...preferences }).success).toBe(false);
  });

  it.each(['models/../escape.gguf', '/absolute.gguf', 'a\\b', 'a\0b'])('does not promote a stored path into a native model mount: %s', async path => {
    const restored = await roundtripPreferences({
      preferences: { modelSelection: { primary: { slot: 'diffusion', location: { kind: 'opfs', path } }, components: [], loras: [] } },
    });
    expect(restored.modelSelection?.primary.location.path).toBe(path);
    expect(modelFileSchema.safeParse({ slot: 'diffusion', file: ggufFile(), path }).success).toBe(false);
  });
});
