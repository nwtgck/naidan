import { describe, expect, it } from 'vitest';
import { encodePersistenceControlUtf8, parsePortableFileSystemId } from '@/00-storage/service/hizofs/compatibility';
import {
  decodePersistenceControl,
  encodePersistenceControl,
  encodeUnsignedProtectedPersistenceControl,
  persistenceControlSemanticallyEquals,
  type NaidanPersistenceControlV1,
  parseTransitionOperationId,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import { fileSystemIdToNaidanContainerToken, parseNaidanContainerToken } from '@/00-storage/service/naidan-persistence-control/00-format/container-path';

const A = parsePortableFileSystemId({ value: '0123456789_ABCDEFGHIJ' });
const B = parsePortableFileSystemId({ value: '1123456789_ABCDEFGHIJ' });
const C = parsePortableFileSystemId({ value: '2123456789_ABCDEFGHIJ' });
const DIGEST = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const NONCE = 'AAAAAAAAAAAAAAAA';
const TAG = 'AAAAAAAAAAAAAAAAAAAAAA';

describe('Naidan canonical container token', () => {
  it('roundtrips the Naidan canonical container token without case-folding the ID', () => {
    const id = parsePortableFileSystemId({ value: 'Abcdefghij_klmnopq-12' });
    const token = fileSystemIdToNaidanContainerToken({ id });
    expect(token).toBe('fs-4162636465666768696a5f6b6c6d6e6f70712d3132.hizofs');
    expect(parseNaidanContainerToken({ value: token })).toBe(id);
    expect(() => parseNaidanContainerToken({ value: token.toUpperCase() })).toThrow();
  });
});

function plain({ copy = 0, sequence = 1 }: { copy?: 0 | 1; sequence?: number } = {}): NaidanPersistenceControlV1 {
  return {
    copy,
    format: 'naidan-persistence-control',
    formatVersion: 1,
    mode: { type: 'plain' },
    protection: { digest: DIGEST, type: 'plain_sha256' },
    retiredFileSystemIds: [],
    sequence,
  };
}

function protectedControl({ mode }: { mode: NaidanPersistenceControlV1['mode'] }): NaidanPersistenceControlV1 {
  const authenticationFileSystemId = mode.type === 'hizofs'
    ? mode.activeFileSystemId
    : mode.type === 'transitioning' && mode.operation === 're_encrypt' && mode.phase.type === 'cleaning_up_source'
      ? B
      : A;
  return {
    copy: 1,
    format: 'naidan-persistence-control',
    formatVersion: 1,
    mode,
    protection: { authenticationFileSystemId, authenticatorTag: TAG, nonce: NONCE, type: 'hizofs_aes_256_gcm' },
    retiredFileSystemIds: [C],
    sequence: 7,
  };
}

describe('Naidan Persistence Control canonical JSON', () => {
  it('round-trips stable plain bytes in exact field order', () => {
    const bytes = encodePersistenceControl({ control: plain() });
    expect(new TextDecoder().decode(bytes)).toBe(`{"format":"naidan-persistence-control","formatVersion":1,"copy":0,"sequence":1,"mode":{"type":"plain"},"retiredFileSystemIds":[],"protection":{"type":"plain_sha256","digest":"${DIGEST}"}}\n`);
    expect(decodePersistenceControl({ bytes })).toEqual(plain());
  });

  it('encodes canonical unsigned protected bytes without an authenticator tag', () => {
    const stable = protectedControl({ mode: { activeFileSystemId: A, type: 'hizofs' } });
    if (stable.protection.type !== 'hizofs_aes_256_gcm') throw new Error('test fixture protection mismatch');
    const bytes = encodeUnsignedProtectedPersistenceControl({
      control: {
        ...stable,
        protection: {
          authenticationFileSystemId: stable.protection.authenticationFileSystemId,
          nonce: stable.protection.nonce,
          type: 'hizofs_aes_256_gcm',
        },
      },
    });
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain(`"protection":{"type":"hizofs_aes_256_gcm","authenticationFileSystemId":"${A}","nonce":"${NONCE}"}`);
    expect(text).not.toContain('authenticatorTag');
  });

  it('round-trips stable HizoFS and transition modes', () => {
    const stable = protectedControl({ mode: { activeFileSystemId: A, type: 'hizofs' } });
    const transition = protectedControl({
      mode: {
        operation: 're_encrypt',
        operationId: parseTransitionOperationId({ value: 'abcdefghijklmnopqrstu' }),
        phase: {
          source: { fileSystemId: A, type: 'hizofs' },
          target: { fileSystemId: B, type: 'hizofs' },
          type: 'cleaning_up_source',
        },
        type: 'transitioning',
      },
    });
    expect(decodePersistenceControl({ bytes: encodePersistenceControl({ control: stable }) })).toEqual(stable);
    expect(decodePersistenceControl({ bytes: encodePersistenceControl({ control: transition }) })).toEqual(transition);
  });

  it('rejects unknown fields and non-canonical order', () => {
    const text = new TextDecoder().decode(encodePersistenceControl({ control: plain() }));
    expect(() => decodePersistenceControl({ bytes: encodePersistenceControlUtf8({ value: text.replace('"formatVersion":1,"copy":0', '"copy":0,"formatVersion":1') }) })).toThrow('canonical order');
    expect(() => decodePersistenceControl({ bytes: encodePersistenceControlUtf8({ value: text.replace('"sequence":1', '"unknown":0,"sequence":1') }) })).toThrow('canonical order');
  });

  it('rejects a UTF-8 BOM before otherwise canonical JSON', () => {
    const encoded = encodePersistenceControl({ control: plain() });
    const prefixed = new Uint8Array(encoded.byteLength + 3);
    prefixed.set([0xef, 0xbb, 0xbf]);
    prefixed.set(encoded, 3);
    expect(() => decodePersistenceControl({ bytes: prefixed })).toThrow();
  });

  it('rejects byte and nesting bounds before authority use', () => {
    expect(() => decodePersistenceControl({ bytes: new Uint8Array(65_537) })).toThrow('byte maximum');
    const tooDeep = '{"a":{"b":{"c":{"d":{"e":1}}}}}\n';
    expect(() => decodePersistenceControl({ bytes: encodePersistenceControlUtf8({ value: tooDeep }) })).toThrow('nesting depth');
  });

  it('rejects invalid sequence and proof material lengths', () => {
    expect(() => encodePersistenceControl({ control: plain({ sequence: 0 }) })).toThrow('integer range');
    expect(() => encodePersistenceControl({ control: { ...plain(), protection: { digest: 'AA', type: 'plain_sha256' } } })).toThrow('32 bytes');
  });

  it('allows plain protection only for stable plain mode', () => {
    expect(() => encodePersistenceControl({ control: { ...plain(), mode: { activeFileSystemId: A, type: 'hizofs' } } })).toThrow('require HizoFS protection');
    expect(() => encodePersistenceControl({ control: { ...protectedControl({ mode: { activeFileSystemId: A, type: 'hizofs' } }), mode: { type: 'plain' } } })).toThrow('requires plain');
  });

  it('enforces operation endpoint and authentication authority rules', () => {
    const invalid = protectedControl({
      mode: {
        operation: 'encrypt',
        operationId: parseTransitionOperationId({ value: 'abcdefghijklmnopqrstu' }),
        phase: {
          source: { fileSystemId: A, type: 'hizofs' },
          target: { fileSystemId: B, type: 'hizofs' },
          type: 'building_target',
        },
        type: 'transitioning',
      },
    });
    expect(() => encodePersistenceControl({ control: invalid })).toThrow('plain to HizoFS');
    const cleaning = protectedControl({
      mode: {
        operation: 're_encrypt',
        operationId: parseTransitionOperationId({ value: 'abcdefghijklmnopqrstu' }),
        phase: {
          source: { fileSystemId: A, type: 'hizofs' },
          target: { fileSystemId: B, type: 'hizofs' },
          type: 'cleaning_up_source',
        },
        type: 'transitioning',
      },
    });
    const protection = cleaning.protection;
    if (protection.type !== 'hizofs_aes_256_gcm') throw new Error('test fixture protection mismatch');
    expect(() => encodePersistenceControl({ control: { ...cleaning, protection: { ...protection, authenticationFileSystemId: A } } })).toThrow('does not match');
  });

  it('requires retired IDs to be strict ascending and disjoint from authority', () => {
    expect(() => encodePersistenceControl({ control: { ...plain(), retiredFileSystemIds: [B, A] } })).toThrow('strict ascending');
    const stable = protectedControl({ mode: { activeFileSystemId: A, type: 'hizofs' } });
    expect(() => encodePersistenceControl({ control: { ...stable, retiredFileSystemIds: [A] } })).toThrow('cannot be retired');
  });

  it('compares only mode and canonical retired IDs semantically', () => {
    expect(persistenceControlSemanticallyEquals({ left: plain({ copy: 0, sequence: 1 }), right: plain({ copy: 1, sequence: 99 }) })).toBe(true);
    expect(persistenceControlSemanticallyEquals({ left: plain(), right: { ...plain(), retiredFileSystemIds: [A] } })).toBe(false);
  });
});
