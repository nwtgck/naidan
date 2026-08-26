import { describe, expect, it } from 'vitest';
import { parseFilePermissionMode } from '@/features/wesh/commands/_shared/file-mode';

describe('parseFilePermissionMode', () => {
  it('applies multiple symbolic operations in one clause from left to right', () => {
    expect(parseFilePermissionMode({
      value: 'u+r-w',
      initialMode: 0o600,
      umask: 0,
      allowSpecialBits: false,
    })).toEqual({ ok: true, mode: 0o400 });

    expect(parseFilePermissionMode({
      value: 'a=rw+x',
      initialMode: 0,
      umask: 0,
      allowSpecialBits: false,
    })).toEqual({ ok: true, mode: 0o777 });
  });

  it('accepts empty symbolic operations as no-ops', () => {
    for (const value of ['-', '--', '---', '+', '++', 'u-', 'u--', 'a-']) {
      expect(parseFilePermissionMode({
        value,
        initialMode: 0o754,
        umask: 0,
        allowSpecialBits: false,
      })).toEqual({ ok: true, mode: 0o754 });
    }
  });

  it('still rejects malformed permission characters inside operation chains', () => {
    expect(parseFilePermissionMode({
      value: 'u+r-q',
      initialMode: 0o600,
      umask: 0,
      allowSpecialBits: false,
    })).toEqual({ ok: false, specialBits: false });
  });
});
