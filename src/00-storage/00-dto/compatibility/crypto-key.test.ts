import { describe, expect, expectTypeOf, it } from 'vitest';
import type * as dtozod from '@/utils/dtozod';
import { CryptoKeySchemaDto } from './crypto-key';
import { ExperimentalNaidanRpcIdentitySchemaDto } from '@/00-storage/00-dto/experimental-naidan-rpc.dto';

describe('structured-clone CryptoKey DTO boundary', () => {
  it.each([undefined, null, 'key', {}, { type: 'private', algorithm: { name: 'X25519' }, usages: ['deriveBits'], extractable: false }])('rejects non-key structures: %j', input => {
    expect(CryptoKeySchemaDto.safeParse(input).success).toBe(false);
  });

  it('keeps real keys and delegates key-use policy to the identity owner', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    for (const key of [pair.privateKey, pair.publicKey]) {
      const value = ExperimentalNaidanRpcIdentitySchemaDto.parse({ privateKey: key, publicKey: '', future: 'field' });
      expect(value.privateKey).toBe(key);
      expect(value).not.toHaveProperty('future');
    }
    expectTypeOf<dtozod.output<typeof CryptoKeySchemaDto>>().toEqualTypeOf<CryptoKey>();
    expectTypeOf<dtozod.input<typeof CryptoKeySchemaDto>>().toEqualTypeOf<CryptoKey>();
    // The service's existing tests reject extractable/public keys for identity
    // use. This DTO only promises CryptoKey, not a usable X25519 private key.
  });

  it('does not expose a general custom-validator or raw-schema escape hatch', () => {
    const compileOnly = () => {
      // @ts-expect-error A trusted type check does not expose arbitrary checks.
      CryptoKeySchemaDto.refine(() => true);
      // @ts-expect-error Raw schema access remains unavailable.
      CryptoKeySchemaDto.unwrap();
    };
    expect(compileOnly).toBeTypeOf('function');
  });
});
