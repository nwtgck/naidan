import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, EMPTY_LM_PARAMETERS, type Settings } from '@/01-models/types';
import { SettingsSchemaDto } from '@/00-storage/00-dto/dto';
import { settingsToDomain, settingsToDto } from './mappers';

function settings(): Settings {
  return { ...DEFAULT_SETTINGS, endpoint: { type: 'openai', url: 'https://example.test' }, storageType: 'memory' };
}

describe('saved title reasoning compatibility', () => {
  it.each([undefined, 'none', 'low', 'medium', 'high'] as const)('round-trips saved %s without applying new-user defaults', effort => {
    const source = settings();
    source.titleGeneration = { endpoint: 'same_scope', model: 'same_scope', lmParameters: { ...EMPTY_LM_PARAMETERS, reasoning: { effort } } };
    const dto = settingsToDto({ domain: source });
    const restored = settingsToDomain({ dto: SettingsSchemaDto.parse(JSON.parse(JSON.stringify(dto))) });
    expect(restored.titleGeneration).toEqual(source.titleGeneration);
  });

  it('keeps legacy unspecified reasoning unspecified rather than migrating to off', () => {
    const serialized = JSON.parse(JSON.stringify(settingsToDto({ domain: settings() })));
    delete serialized.titleGeneration;
    serialized.autoTitleEnabled = true;
    serialized.titleModelId = 'saved-model';
    const restored = settingsToDomain({ dto: SettingsSchemaDto.parse(serialized) });
    expect(restored.titleGeneration).toMatchObject({ model: { id: 'saved-model' }, lmParameters: { reasoning: { effort: undefined } } });
  });

  it('keeps disabled and same-scope saved settings unchanged', () => {
    for (const titleGeneration of ['disabled', { endpoint: 'same_scope', model: 'same_scope', lmParameters: 'same_scope' }] as const) {
      const source = { ...settings(), titleGeneration };
      expect(settingsToDomain({ dto: settingsToDto({ domain: source }) }).titleGeneration).toEqual(titleGeneration);
    }
  });
});
