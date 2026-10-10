import { describe, expect, it } from 'vitest';
import { SettingsSchemaDto } from '@/00-storage/00-dto/dto';
import { ExperimentalLlamaCppBrowserSettingsSchemaDto } from '@/00-storage/00-dto/experimental.dto';
import { toHostModelDirectoryId } from '@/01-models/ids';
import { DEFAULT_SETTINGS, type LlamaCppBrowserSettings, type Settings } from '@/01-models/types';
import { settingsToDomain, settingsToDto } from './mappers';

const base: Settings = { ...DEFAULT_SETTINGS, endpoint: { type: 'openai', url: '' }, storageType: 'local' };

describe('llama.cpp browser model download destination settings', () => {
  it('keeps legacy settings without the llama.cpp group readable and absent on disk', () => {
    const saved = settingsToDto({ domain: base });
    const read = settingsToDomain({ dto: SettingsSchemaDto.parse(JSON.parse(JSON.stringify(saved))) });

    expect(read.experimental?.llamaCppBrowser).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain('llamaCppBrowser');
  });

  it('materializes a missing nested destination as undefined without selecting a default', () => {
    expect(ExperimentalLlamaCppBrowserSettingsSchemaDto.parse({})).toStrictEqual({ modelDownloadDestination: undefined });
    const dto = SettingsSchemaDto.parse({ ...settingsToDto({ domain: base }), experimental: { llamaCppBrowser: {} } });
    const read = settingsToDomain({ dto });

    expect(read.experimental?.llamaCppBrowser).toStrictEqual({ modelDownloadDestination: undefined });
    expect(settingsToDto({ domain: read }).experimental?.llamaCppBrowser).toStrictEqual({ modelDownloadDestination: undefined });
  });

  it.each<LlamaCppBrowserSettings['modelDownloadDestination']>([
    { kind: 'opfs' },
    { kind: 'host', directoryId: toHostModelDirectoryId({ raw: 'linked-lm-models' }) },
    // An unresolved identifier is still a string; using the directory is a
    // separate operation and must not be inferred from successful DTO parsing.
    { kind: 'host', directoryId: toHostModelDirectoryId({ raw: '' }) },
  ])('roundtrips the explicit destination independently of image generation preferences: %j', modelDownloadDestination => {
    const imageDirectoryId = toHostModelDirectoryId({ raw: 'linked-image-models' });
    const saved = settingsToDto({
      domain: {
        ...base,
        experimental: {
          locale: 'ja',
          llamaCppBrowser: { modelDownloadDestination },
          browserImageGeneration: { modelDownloadDestination: { kind: 'host', directoryId: imageDirectoryId }, width: 512 },
          hostModelDirectories: [{ id: imageDirectoryId, name: 'image models' }],
        },
      },
    });
    const parsed = SettingsSchemaDto.parse(JSON.parse(JSON.stringify(saved)));
    const restored = settingsToDomain({ dto: parsed });

    expect(saved.experimental?.llamaCppBrowser).toStrictEqual({ modelDownloadDestination });
    expect(restored.experimental?.llamaCppBrowser).toStrictEqual({ modelDownloadDestination });
    expect(restored.experimental?.browserImageGeneration?.modelDownloadDestination).toStrictEqual({ kind: 'host', directoryId: imageDirectoryId });
    expect(restored.experimental?.browserImageGeneration?.width).toBe(512);
    expect(restored.experimental?.locale).toBe('ja');
    expect(settingsToDto({ domain: restored })).toStrictEqual(saved);
  });

  it('persists only the host registration ID even when the source has display or handle metadata', () => {
    const directoryId = toHostModelDirectoryId({ raw: 'stable-registration-id' });
    const destination = {
      kind: 'host' as const,
      directoryId,
      name: 'private folder display name',
      handle: { kind: 'directory', name: 'private folder handle' },
    };
    const saved = settingsToDto({ domain: { ...base, experimental: { llamaCppBrowser: { modelDownloadDestination: destination } } } });

    expect(saved.experimental?.llamaCppBrowser).toStrictEqual({
      modelDownloadDestination: { kind: 'host', directoryId: 'stable-registration-id' },
    });
    expect(JSON.stringify(saved)).not.toContain('private folder');
    expect(JSON.stringify(saved)).not.toContain('handle');
  });

  it('drops unrecognized nested metadata while keeping a valid registration ID', () => {
    const dto = SettingsSchemaDto.parse({
      ...settingsToDto({ domain: base }),
      experimental: {
        llamaCppBrowser: {
          modelDownloadDestination: { kind: 'host', directoryId: 'linked-models', name: 'models', handle: { kind: 'directory' } },
        },
      },
    });
    const read = settingsToDomain({ dto });

    expect(read.experimental?.llamaCppBrowser).toStrictEqual({
      modelDownloadDestination: { kind: 'host', directoryId: toHostModelDirectoryId({ raw: 'linked-models' }) },
    });
    expect(read.experimental?.unreadable).toBeUndefined();
  });

  it.each([
    null,
    [],
    'host',
    { modelDownloadDestination: null },
    { modelDownloadDestination: [] },
    { modelDownloadDestination: {} },
    { modelDownloadDestination: { kind: 'future_destination' } },
    { modelDownloadDestination: { kind: 'host' } },
    { modelDownloadDestination: { kind: 'host', directoryId: 42 } },
  ])('isolates an unreadable llama.cpp group without discarding unrelated settings: %j', invalid => {
    const dto = SettingsSchemaDto.parse({
      ...settingsToDto({ domain: base }),
      experimental: {
        locale: 'ja',
        llamaCppBrowser: invalid,
        browserImageGeneration: { modelDownloadDestination: { kind: 'opfs' }, width: 512 },
        hostModelDirectories: [{ id: 'linked-models', name: 'models' }],
      },
    });
    const restored = settingsToDomain({ dto });

    expect(restored.experimental?.llamaCppBrowser).toBeUndefined();
    expect(restored.experimental?.unreadable).toStrictEqual({ llamaCppBrowser: invalid });
    expect(restored.experimental?.locale).toBe('ja');
    expect(restored.experimental?.browserImageGeneration?.modelDownloadDestination).toStrictEqual({ kind: 'opfs' });
    expect(restored.experimental?.browserImageGeneration?.width).toBe(512);
    expect(restored.experimental?.hostModelDirectories).toStrictEqual([{ id: toHostModelDirectoryId({ raw: 'linked-models' }), name: 'models' }]);
  });
});
