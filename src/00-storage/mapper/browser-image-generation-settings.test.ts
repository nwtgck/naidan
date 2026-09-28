import { describe, expect, it } from 'vitest';
import { SettingsSchemaDto } from '@/00-storage/00-dto/dto';
import { DEFAULT_BROWSER_IMAGE_GENERATION_SETTINGS, DEFAULT_SETTINGS, type BrowserImageGenerationSettings, type Settings } from '@/01-models/types';
import { toHostModelDirectoryId } from '@/01-models/ids';
import { settingsToDomain, settingsToDto } from './mappers';

const base: Settings = { ...DEFAULT_SETTINGS, endpoint: { type: 'openai', url: '' }, storageType: 'local' };

describe('browser image generation settings', () => {
  it('keeps absent preferences absent while exposing the current editor defaults separately', () => {
    const saved = settingsToDto({ domain: base });
    const read = settingsToDomain({ dto: SettingsSchemaDto.parse(saved) });
    expect(read.experimental?.browserImageGeneration).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain('browserImageGeneration');
    expect(DEFAULT_BROWSER_IMAGE_GENERATION_SETTINGS).toMatchObject({
      width: 256, height: 256, seedMode: 'random', seed: '42', historyPersistence: 'enabled',
      modelDownloadDestination: { kind: 'opfs' }, imageDownload: { format: 'png', metadata: 'omit' },
      preview: { enabled: 'disabled', mode: 'vae', interval: 2, startStep: 1, maxEdge: 256 },
      keepPreviews: 'enabled', maxPreviews: 16, maxResults: 20, bf16WeightType: 'f32',
    });
  });

  it('roundtrips independent model locations, slots, output preferences, and host IDs', () => {
    const directoryId = toHostModelDirectoryId({ raw: 'linked-models' });
    const preferences: BrowserImageGenerationSettings = {
      width: 512, height: 768, seedMode: 'fixed', seed: '9223372036854775807', historyPersistence: 'disabled',
      modelDownloadDestination: { kind: 'host', directoryId },
      imageDownload: { format: 'webp', metadata: 'include' },
      modelSelection: {
        primary: { slot: 'diffusion', location: { kind: 'opfs', path: 'models/huggingface.co/owner/base/resolve/main/weights/model.safetensors.index.json' } },
        components: [
          { slot: 'vae', choice: { kind: 'file', location: { kind: 'host', directoryId, path: 'other-owner/decoder/vae/model.safetensors' } } },
          { slot: 'lm', choice: { kind: 'none' } },
        ],
        loras: [
          { location: { kind: 'host', directoryId, path: 'third-owner/style/style.safetensors' }, enabled: 'enabled', strength: 0.75 },
          { location: { kind: 'opfs', path: 'models/user/imported-lora/adapter.gguf' }, enabled: 'disabled', strength: -1 },
        ],
      },
      preview: { enabled: 'enabled', mode: 'projection', interval: 3, startStep: 2, maxEdge: 0 },
      keepPreviews: 'disabled', maxPreviews: 8, maxResults: 12, bf16WeightType: 'f16',
    };
    const saved = settingsToDto({ domain: { ...base, experimental: { browserImageGeneration: preferences,
      hostModelDirectories: [{ id: directoryId, name: 'models' }] } } });
    const raw = JSON.parse(JSON.stringify(saved));
    expect(raw.experimental.browserImageGeneration.modelDownloadDestination).toEqual({ kind: 'host', directoryId: 'linked-models' });
    expect(raw.experimental.browserImageGeneration.modelSelection.components[0].choice.location).toEqual({
      kind: 'host', directoryId: 'linked-models', path: 'other-owner/decoder/vae/model.safetensors',
    });
    expect(raw.experimental.browserImageGeneration.modelSelection.components[1].choice).toEqual({ kind: 'none' });
    expect(raw.experimental.hostModelDirectories).toEqual([{ id: 'linked-models', name: 'models' }]);
    const restored = settingsToDomain({ dto: SettingsSchemaDto.parse(raw) });
    expect(restored.experimental?.browserImageGeneration).toEqual(preferences);
    expect(restored.experimental?.hostModelDirectories).toEqual([{ id: directoryId, name: 'models' }]);
  });

  it.each([
    { width: 255 },
    { seed: '9223372036854775808' },
    { seed: 'abc' },
    { seed: '' },
    { seed: '1e3' },
    { imageDownload: { format: 'gif', metadata: 'omit' } },
    { modelDownloadDestination: { kind: 'host' } },
    { modelSelection: { primary: { slot: 'diffusion', location: { kind: 'opfs', path: 'models/../escape.gguf' } }, components: [], loras: [] } },
    { modelSelection: { primary: { slot: 'diffusion', location: { kind: 'host', directoryId: 'linked-models', path: '/absolute.gguf' } }, components: [], loras: [] } },
  ])('isolates an invalid browser image group without failing the whole Settings DTO: %j', invalid => {
    const dto = SettingsSchemaDto.parse({ ...settingsToDto({ domain: base }), experimental: {
      locale: 'ja', hostModelDirectories: [{ id: 'linked-models', name: 'models' }], browserImageGeneration: invalid,
    } });
    const read = settingsToDomain({ dto });
    expect(read.experimental?.locale).toBe('ja');
    expect(read.experimental?.hostModelDirectories).toEqual([{ id: toHostModelDirectoryId({ raw: 'linked-models' }), name: 'models' }]);
    expect(read.experimental?.browserImageGeneration).toBeUndefined();
    expect(read.experimental?.unreadable).toEqual({ browserImageGeneration: invalid });
  });

  it('materializes missing nested fields as undefined without inventing a model selection', () => {
    const dto = SettingsSchemaDto.parse({ ...settingsToDto({ domain: base }), experimental: {
      browserImageGeneration: { width: 256, preview: { interval: 2 }, imageDownload: { format: 'jpeg' } },
    } });
    const read = settingsToDomain({ dto });
    expect(read.experimental?.browserImageGeneration).toMatchObject({
      width: 256, height: undefined, modelSelection: undefined,
      preview: { enabled: undefined, mode: undefined, interval: 2, startStep: undefined, maxEdge: undefined },
      imageDownload: { format: 'jpeg', metadata: undefined },
    });
  });
});
