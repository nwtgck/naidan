import { beforeEach, describe, expect, it } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { formatSettingsSourceLabel } from './settings-labels';

describe('formatSettingsSourceLabel', () => {
  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
  });

  it('formats English default and inherited setting labels', () => {
    expect(formatSettingsSourceLabel({ value: undefined, source: undefined })).toBe('Default');
    expect(formatSettingsSourceLabel({ value: 'Model A', source: 'global' })).toBe('Model A (Global)');
    expect(formatSettingsSourceLabel({ value: 'Model B', source: 'chat_group' })).toBe('Model B (Group)');
    expect(formatSettingsSourceLabel({ value: 'Model C', source: 'chat' })).toBe('Model C');
  });

  it('formats Japanese default and inherited setting labels', async () => {
    await ensureAllStringsForTest({ locale: 'ja' });

    expect(formatSettingsSourceLabel({ value: undefined, source: undefined })).toBe('デフォルト');
    expect(formatSettingsSourceLabel({ value: 'モデルA', source: 'global' })).toBe('モデルA（グローバル）');
    expect(formatSettingsSourceLabel({ value: 'モデルB', source: 'chat_group' })).toBe('モデルB（グループ）');
    expect(formatSettingsSourceLabel({ value: 'モデルC', source: 'chat' })).toBe('モデルC');
  });
});
