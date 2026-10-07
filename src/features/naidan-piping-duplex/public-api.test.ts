// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as api from '@/features/naidan-piping-duplex';
import * as peerKeys from '@/features/naidan-piping-duplex/peer-key';

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request in unit test'));
});

afterEach(() => vi.restoreAllMocks());

it('the public duplex facade has a functional name and keeps key-only access separate', () => {
  expect(Object.keys(api).sort()).toEqual([
    'NaidanPipingDuplexSession',
    'TEST_ONLY',
    'createNaidanPipingCode',
    'createNaidanPipingIdentity',
    'establishNaidanPipingKeys',
  ].sort());
  expect(api.NaidanPipingDuplexSession.name).toBe('NaidanPipingDuplexSession');
  expect(Object.keys(peerKeys).sort()).toEqual([
    'TEST_ONLY', 'createNaidanPipingIdentity', 'establishNaidanPipingKeys',
  ].sort());
  expect(api.establishNaidanPipingKeys).toBe(peerKeys.establishNaidanPipingKeys);
  expect(api.createNaidanPipingIdentity).toBe(peerKeys.createNaidanPipingIdentity);
});
