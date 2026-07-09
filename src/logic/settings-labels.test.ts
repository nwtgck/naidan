import { beforeEach, describe, expect, it } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { formatSettingsSourceLabel } from './settings-labels';

describe('formatSettingsSourceLabel', () => {
  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
  });

  it('formats English empty and inherited setting labels', () => {
    expect(formatSettingsSourceLabel({ value: undefined, source: undefined })).toBe('None');
    expect(formatSettingsSourceLabel({ value: 'Model A', source: 'global' })).toBe('Global: Model A');
    expect(formatSettingsSourceLabel({ value: 'Model B', source: 'chat_group' })).toBe('Chat Group: Model B');
    expect(formatSettingsSourceLabel({ value: 'Model C', source: 'chat' })).toBe('Chat: Model C');
  });

  it('formats Japanese empty and inherited setting labels', async () => {
    await ensureAllStringsForTest({ locale: 'ja' });

    expect(formatSettingsSourceLabel({ value: undefined, source: undefined })).toBe('なし');
    expect(formatSettingsSourceLabel({ value: 'モデルA', source: 'global' })).toBe('グローバル: モデルA');
    expect(formatSettingsSourceLabel({ value: 'モデルB', source: 'chat_group' })).toBe('チャットグループ: モデルB');
    expect(formatSettingsSourceLabel({ value: 'モデルC', source: 'chat' })).toBe('チャット: モデルC');
  });
});
