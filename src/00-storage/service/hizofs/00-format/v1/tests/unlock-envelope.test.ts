import { describe, expect, it } from 'vitest';
import { encodeBase64UrlUnpadded } from '@/00-storage/service/hizofs/00-format/v1/encoding/base64-url';
import { parseCredentialSlotId, parseFileSystemId } from '@/00-storage/service/hizofs/00-format/v1/identifiers';
import { decodeUnlockEnvelope, encodeUnlockEnvelope, type UnlockEnvelopeV1 } from '@/00-storage/service/hizofs/00-format/v1/canonical-json/unlock-envelope';
import {
  HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD,
  decodePassphraseCredentialParametersV1,
  encodePassphraseCredentialParametersV1,
} from '@/00-storage/service/hizofs/00-format/v1/credential/passphrase-credential';

function knownParameters({ iterations }: { iterations: number }): string {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 16; index += 1) bytes[index] = index + 1;
  new DataView(bytes.buffer).setUint32(16, iterations, false);
  for (let index = 20; index < 32; index += 1) bytes[index] = index + 1;
  return encodeBase64UrlUnpadded({ bytes });
}

function createEnvelope(): UnlockEnvelopeV1 {
  return {
    authenticatorNonce: encodeBase64UrlUnpadded({ bytes: Uint8Array.from({ length: 12 }, (_, index) => index + 1) }),
    authenticatorTag: encodeBase64UrlUnpadded({ bytes: Uint8Array.from({ length: 16 }, (_, index) => 0xf0 + index) }),
    copy: 0,
    credentialSlots: [{
      method: 'passphrase_pbkdf2_hmac_sha256_aes_256_gcm',
      methodParameters: knownParameters({ iterations: 600_000 }),
      methodVersion: 1,
      slotId: parseCredentialSlotId({ value: 'Abcdefghij_klmnopq-12' }),
      type: 'credential',
      wrappedFileSystemRootKey: encodeBase64UrlUnpadded({ bytes: Uint8Array.from({ length: 48 }, (_, index) => index) }),
    }],
    fileSystemId: parseFileSystemId({ value: 'Zbcdefghij_klmnopq-12' }),
    format: 'hizofs-unlock',
    formatVersion: 1,
    sequence: 1,
  };
}

function replaceAscii({ bytes, from, to }: { bytes: Uint8Array; from: string; to: string }): Uint8Array {
  const text = new TextDecoder().decode(bytes);
  if (!text.includes(from)) throw new Error(`fixture fragment not found: ${from}`);
  return new TextEncoder().encode(text.replace(from, to));
}

describe('HizoFS V1 Unlock Envelope canonical JSON', () => {
  it('owns the exact passphrase credential parameter bytes', () => {
    const parameters = {
      iterations: 600_000,
      nonce: Uint8Array.from({ length: HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.nonceBytes }, (_, index) => index + 17),
      salt: Uint8Array.from({ length: HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.saltBytes }, (_, index) => index + 1),
    };
    const encoded = encodePassphraseCredentialParametersV1({ parameters });
    expect(encoded.byteLength).toBe(HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.parametersBytes);
    expect(encoded.subarray(0, 16)).toEqual(parameters.salt);
    expect(new DataView(encoded.buffer, encoded.byteOffset + 16, 4).getUint32(0, false)).toBe(600_000);
    expect(encoded.subarray(20)).toEqual(parameters.nonce);
    expect(decodePassphraseCredentialParametersV1({ bytes: encoded })).toEqual(parameters);
  });

  it('roundtrips one exact canonical fixture', () => {
    const envelope = createEnvelope();
    const encoded = encodeUnlockEnvelope({ envelope });
    expect(new TextDecoder().decode(encoded)).toBe(
      `{"format":"hizofs-unlock","formatVersion":1,"copy":0,"sequence":1,"fileSystemId":"Zbcdefghij_klmnopq-12","credentialSlots":[{"type":"credential","slotId":"Abcdefghij_klmnopq-12","method":"passphrase_pbkdf2_hmac_sha256_aes_256_gcm","methodVersion":1,"methodParameters":"${envelope.credentialSlots[0]?.methodParameters}","wrappedFileSystemRootKey":"${envelope.credentialSlots[0]?.wrappedFileSystemRootKey}"}],"authenticatorNonce":"${envelope.authenticatorNonce}","authenticatorTag":"${envelope.authenticatorTag}"}\n`,
    );
    expect(decodeUnlockEnvelope({ bytes: encoded })).toEqual(envelope);
    expect(new TextDecoder().decode(encodeUnlockEnvelope({ envelope, includeAuthenticatorTag: false }))).not.toContain('authenticatorTag');
  });

  it('rejects duplicate, unknown, reordered, escaped, and whitespace forms', () => {
    const encoded = encodeUnlockEnvelope({ envelope: createEnvelope() });
    expect(() => decodeUnlockEnvelope({ bytes: replaceAscii({ bytes: encoded, from: '"copy":0', to: '"copy":0,"copy":0' }) })).toThrow('duplicate');
    expect(() => decodeUnlockEnvelope({ bytes: replaceAscii({ bytes: encoded, from: '"copy":0', to: '"unknown":0,"copy":0' }) })).toThrow('unknown');
    expect(() => decodeUnlockEnvelope({ bytes: replaceAscii({ bytes: encoded, from: '"formatVersion":1,"copy":0', to: '"copy":0,"formatVersion":1' }) })).toThrow('canonical order');
    expect(() => decodeUnlockEnvelope({ bytes: replaceAscii({ bytes: encoded, from: '"hizofs-unlock"', to: '"hizofs\\u002dunlock"' }) })).toThrow('unescaped printable ASCII');
    expect(() => decodeUnlockEnvelope({ bytes: replaceAscii({ bytes: encoded, from: ',"copy"', to: ', "copy"' }) })).toThrow('expected');
  });

  it('rejects noncanonical integer, missing LF, excessive bytes, and excessive depth before semantic use', () => {
    const encoded = encodeUnlockEnvelope({ envelope: createEnvelope() });
    expect(() => decodeUnlockEnvelope({ bytes: replaceAscii({ bytes: encoded, from: '"sequence":1', to: '"sequence":01' }) })).toThrow('leading zero');
    expect(() => decodeUnlockEnvelope({ bytes: encoded.subarray(0, encoded.byteLength - 1) })).toThrow('exactly one LF');
    expect(() => decodeUnlockEnvelope({ bytes: new Uint8Array(65_537) })).toThrow('byte maximum');
    const deep = new TextEncoder().encode('{"a":[[[[0]]]]}\n');
    expect(() => decodeUnlockEnvelope({ bytes: deep })).toThrow('nesting depth');
  });

  it('rejects unsorted or duplicate slots', () => {
    const first = createEnvelope();
    const secondSlot = {
      ...first.credentialSlots[0]!,
      slotId: parseCredentialSlotId({ value: '0bcdefghij_klmnopq-12' }),
    };
    const unsorted: UnlockEnvelopeV1 = { ...first, credentialSlots: [first.credentialSlots[0]!, secondSlot] };
    expect(() => decodeUnlockEnvelope({ bytes: encodeUnlockEnvelope({ envelope: unsorted }) })).toThrow('strict ascending');
    const duplicate: UnlockEnvelopeV1 = { ...first, credentialSlots: [first.credentialSlots[0]!, first.credentialSlots[0]!] };
    expect(() => decodeUnlockEnvelope({ bytes: encodeUnlockEnvelope({ envelope: duplicate }) })).toThrow('strict ascending');
  });

  it('preserves a bounded unknown credential method without executing it', () => {
    const envelope = createEnvelope();
    const unknown: UnlockEnvelopeV1 = {
      ...envelope,
      credentialSlots: [{
        ...envelope.credentialSlots[0]!,
        method: 'future_method',
        methodParameters: encodeBase64UrlUnpadded({ bytes: Uint8Array.of(1, 2, 3) }),
        methodVersion: 2,
        wrappedFileSystemRootKey: encodeBase64UrlUnpadded({ bytes: Uint8Array.of(4, 5) }),
      }],
    };
    expect(decodeUnlockEnvelope({ bytes: encodeUnlockEnvelope({ envelope: unknown }) })).toEqual(unknown);
  });

  it('rejects cumulative known-method work above the semantic envelope maximum', () => {
    const envelope = createEnvelope();
    const credentialSlots = ['0bcdefghij_klmnopq-12', '1bcdefghij_klmnopq-12', '2bcdefghij_klmnopq-12'].map(value => ({
      ...envelope.credentialSlots[0]!,
      methodParameters: knownParameters({ iterations: 10_000_000 }),
      slotId: parseCredentialSlotId({ value }),
    }));
    expect(() => decodeUnlockEnvelope({
      bytes: encodeUnlockEnvelope({ envelope: { ...envelope, credentialSlots } }),
    })).toThrow('cumulative bound');
  });

  it('enforces known credential byte lengths and PBKDF2 work bounds before execution', () => {
    const envelope = createEnvelope();
    const shortParameters: UnlockEnvelopeV1 = {
      ...envelope,
      credentialSlots: [{ ...envelope.credentialSlots[0]!, methodParameters: encodeBase64UrlUnpadded({ bytes: new Uint8Array(31) }) }],
    };
    expect(() => decodeUnlockEnvelope({ bytes: encodeUnlockEnvelope({ envelope: shortParameters }) })).toThrow('byte length');
    const weak: UnlockEnvelopeV1 = {
      ...envelope,
      credentialSlots: [{ ...envelope.credentialSlots[0]!, methodParameters: knownParameters({ iterations: 599_999 }) }],
    };
    expect(() => decodeUnlockEnvelope({ bytes: encodeUnlockEnvelope({ envelope: weak }) })).toThrow('PBKDF2');
  });
});
