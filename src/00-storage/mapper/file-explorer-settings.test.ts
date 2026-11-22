import { describe, expect, it } from 'vitest';
import { SettingsSchemaDto } from '@/00-storage/00-dto/dto';
import { DEFAULT_SETTINGS, DEFAULT_SETTINGS_ENDPOINT, type Settings } from '@/01-models/types';
import { settingsToDomain, settingsToDto } from './mappers';

const base: Settings = { ...DEFAULT_SETTINGS, endpoint: DEFAULT_SETTINGS_ENDPOINT, storageType: 'local' };

describe('experimental File Explorer settings persistence', () => {
  it('round trips all display preferences and retains other experimental settings', () => {
    const fileExplorer = {
      viewMode: 'tree',
      previewVisibility: 'hidden',
      previewWidthPx: 360,
      treeVisibility: 'visible',
      treeWidthPx: 240,
      fileInformationVisibility: 'hidden',
      sortField: 'dateModified',
      sortDirection: 'descending',
      wordWrap: 'wrap',
      editorLineNumbers: 'shown',
    } as const;
    const stored = JSON.stringify(settingsToDto({ domain: { ...base, experimental: { locale: 'ja', fileExplorer } } }));
    const domain = settingsToDomain({ dto: SettingsSchemaDto.parse(JSON.parse(stored)) });

    expect(domain.experimental?.fileExplorer).toStrictEqual(fileExplorer);
    expect(domain.experimental?.locale).toBe('ja');
  });

  it.each([undefined, {}])('omits legacy and empty preferences from saved JSON: %j', fileExplorer => {
    const existing = settingsToDto({ domain: base });
    const dto = SettingsSchemaDto.parse({ ...existing, experimental: { locale: 'ja', fileExplorer } });
    const domain = settingsToDomain({ dto });

    expect(domain.experimental?.fileExplorer).toBeUndefined();
    expect(domain.experimental?.locale).toBe('ja');
    expect(JSON.stringify(settingsToDto({ domain }))).not.toContain('fileExplorer');
  });

  it('isolates unreadable preferences and serializes the remaining fields', () => {
    const existing = settingsToDto({ domain: base });
    const dto = SettingsSchemaDto.parse({
      ...existing,
      experimental: {
        locale: 'ja',
        fileExplorer: {
          viewMode: 'future-layout',
          previewWidthPx: 'wide',
          wordWrap: 'no_wrap',
          editorLineNumbers: 'hidden',
          futureField: true,
        },
      },
    });
    const domain = settingsToDomain({ dto });

    expect(dto.experimental?.fileExplorer?.unreadable).toEqual({ viewMode: 'future-layout', previewWidthPx: 'wide', futureField: true });
    expect(domain.experimental?.locale).toBe('ja');
    expect(domain.experimental?.fileExplorer?.viewMode).toBeUndefined();
    expect(domain.experimental?.fileExplorer?.previewWidthPx).toBeUndefined();
    expect(JSON.stringify(settingsToDto({ domain }).experimental?.fileExplorer)).toBe(JSON.stringify({ wordWrap: 'no_wrap', editorLineNumbers: 'hidden' }));
  });
});
