import { describe, expect, it } from 'vitest';
import { createFakeLmSeedFromRequest } from '@/services/fake-lm/api/fakeLmRequestSeed';

describe('createFakeLmSeedFromRequest', () => {
  it('returns the same seed for the same model and messages', () => {
    const input = {
      model: 'fake-lm-ja',
      messages: [
        { role: 'user', content: 'hello' },
      ],
      thinkingEffort: 'off' as const,
    };

    expect(createFakeLmSeedFromRequest(input)).toBe(createFakeLmSeedFromRequest(input));
  });

  it('includes additional message fields in the seed material', () => {
    const base = createFakeLmSeedFromRequest({
      model: 'fake-lm-ja',
      messages: [
        { role: 'user', content: 'hello', images: ['image-a'] },
      ],
      thinkingEffort: 'off',
    });

    const changed = createFakeLmSeedFromRequest({
      model: 'fake-lm-ja',
      messages: [
        { role: 'user', content: 'hello', images: ['image-b'] },
      ],
      thinkingEffort: 'off',
    });

    expect(changed).not.toBe(base);
  });

  it('includes thinking effort in the seed material', () => {
    const off = createFakeLmSeedFromRequest({
      model: 'fake-lm-ja',
      messages: [
        { role: 'user', content: 'hello' },
      ],
      thinkingEffort: 'off',
    });

    const high = createFakeLmSeedFromRequest({
      model: 'fake-lm-ja',
      messages: [
        { role: 'user', content: 'hello' },
      ],
      thinkingEffort: 'high',
    });

    expect(high).not.toBe(off);
  });
});
