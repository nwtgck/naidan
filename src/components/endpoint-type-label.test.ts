import { beforeEach, describe, expect, it } from 'vitest';

import { ensureAllStringsForTest } from '@/strings/test-utils';

import { endpointTypeLabel } from './endpoint-type-label';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'ja' });
});

describe('endpointTypeLabel', () => {
  it('uses the localized browser-provided label', () => {
    expect(endpointTypeLabel({ endpointType: 'browser_provided_lm' })).toBe('ブラウザ提供');
  });
});
