import { describe, expect, it } from 'vitest';
import {
  decodeNativePlainTransitionTargetCheckpoint,
  encodeNativePlainTransitionTargetCheckpoint,
} from '@/00-storage/service/naidan-persistence-control/00-format/plain-transition-target-checkpoint';

const text = new TextDecoder();
const bytes = new TextEncoder();

describe('native plain transition target checkpoint codec', () => {
  it.each(['preparing', 'active', 'sealed', 'published'] as const)('round-trips canonical %s lifecycle bytes', (lifecycle) => {
    const encoded = encodeNativePlainTransitionTargetCheckpoint({ checkpoint: { lifecycle } });
    expect(text.decode(encoded)).toBe(`{"format":"naidan-opfs-plain-target","formatVersion":1,"lifecycle":"${lifecycle}"}\n`);
    expect(decodeNativePlainTransitionTargetCheckpoint({ bytes: encoded })).toEqual({ lifecycle });
  });

  it('rejects unknown, reordered, or non-canonical values', () => {
    expect(() => decodeNativePlainTransitionTargetCheckpoint({
      bytes: bytes.encode('{"formatVersion":1,"format":"naidan-opfs-plain-target","lifecycle":"active"}\n'),
    })).toThrow('canonical order');
    expect(() => decodeNativePlainTransitionTargetCheckpoint({
      bytes: bytes.encode('{"format":"naidan-opfs-plain-target","formatVersion":1,"lifecycle":"unknown"}\n'),
    })).toThrow('unsupported');
    expect(() => decodeNativePlainTransitionTargetCheckpoint({
      bytes: bytes.encode('{"format":"naidan-opfs-plain-target","formatVersion":1,"lifecycle":"active"}'),
    })).toThrow('canonical');
  });
});
