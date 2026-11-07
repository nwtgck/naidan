import { installSecretEqualityTester } from '@/utils/secret.test-support';
import { describe, expect, it } from 'vitest';
import { toChatId, toChatGroupId } from '@/01-models/ids';
import { Secret } from '@/utils/secret';
import type { HttpEndpoint } from '@/01-models/types';
import { areModelBindingSnapshotsEqual, type ModelBindingSnapshot } from './model-binding';

installSecretEqualityTester();

function snapshot({ value }: { value: string }): ModelBindingSnapshot {
  const endpoint: HttpEndpoint = { type: 'openai', url: 'https://example.invalid', httpHeaders: [['X-Custom', Secret.from({ value })]] };
  return {
    chatId: toChatId({ raw: 'chat' }),
    sourceModelId: 'model',
    chat: { groupId: toChatGroupId({ raw: 'group' }), endpoint, modelId: 'model' },
    chatGroup: { id: toChatGroupId({ raw: 'group' }), endpoint, modelId: 'model' },
    global: { endpoint, modelId: 'model' },
    chatRevision: 1,
    chatGroupRevision: 2,
    chatGroupTarget: 'candidate',
    isCurrent: () => true,
  };
}

describe('protected model binding snapshots', () => {
  it('ignores callback identity but compares independently reconstructed credentials', () => {
    expect(areModelBindingSnapshotsEqual({ left: snapshot({ value: 'same' }), right: snapshot({ value: 'same' }) })).toBe(true);
  });

  it.each(['chat', 'chatGroup', 'global'] as const)('detects a credential-only change in %s', key => {
    const left = snapshot({ value: 'old' });
    const right = { ...left, [key]: snapshot({ value: 'new' })[key] };
    expect(JSON.stringify(left)).toBe(JSON.stringify(right));
    expect(areModelBindingSnapshotsEqual({ left, right })).toBe(false);
  });
});
