import { describe, expect, it } from 'vitest';
import {
  decodeTransitionProgressEnvelope,
  decodeTransitionProgressPlaintext,
  encodeTransitionProgressEnvelope,
  encodeTransitionProgressPlaintext,
  encodeUnsignedTransitionProgressEnvelope,
  parseTransitionOperationId,
  type NaidanTransitionProgressEnvelopeV1,
  type TransitionProgressPayloadV1,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import { encodePersistenceControlBase64Url, parsePortableFileSystemId } from '@/00-storage/service/hizofs/compatibility';

const FILE_SYSTEM_ID = parsePortableFileSystemId({ value: 'a00000000000000000000' });
const TARGET_FILE_SYSTEM_ID = parsePortableFileSystemId({ value: 'b00000000000000000000' });
const OPERATION_ID = parseTransitionOperationId({ value: 'operation000000000000' });

function payload(): TransitionProgressPayloadV1 {
  return {
    journalGeneration: 7n,
    portableProgressBytes: Uint8Array.of(1, 2, 3),
    providerCheckpointCodec: 'hizofs-streaming-namespace-import-v1',
    providerCheckpointBytes: Uint8Array.of(4, 5, 6),
    providerCheckpointState: 'active',
    sourceAuthorityIdentity: 'source-authority-v1',
    sourceEndpoint: { fileSystemId: FILE_SYSTEM_ID, type: 'hizofs' },
    targetAuthorityIdentity: 'target-authority-v1',
    targetEndpoint: { fileSystemId: TARGET_FILE_SYSTEM_ID, type: 'hizofs' },
  };
}

function envelope(): NaidanTransitionProgressEnvelopeV1 {
  return {
    authenticationFileSystemId: TARGET_FILE_SYSTEM_ID,
    ciphertext: encodePersistenceControlBase64Url({ bytes: new Uint8Array(16).fill(9) }),
    copy: 1,
    format: 'naidan-transition-progress',
    formatVersion: 1,
    nonce: encodePersistenceControlBase64Url({ bytes: new Uint8Array(12).fill(8) }),
    operationId: OPERATION_ID,
    providerKind: 'hizofs',
    sequence: 11,
  };
}

describe('Naidan transition-progress canonical JSON', () => {
  it('round-trips exact bounded plaintext without losing bigint or bytes', () => {
    const encoded = encodeTransitionProgressPlaintext({ payload: payload() });
    expect(new TextDecoder().decode(encoded)).toBe(
      '{"sourceAuthorityIdentity":"source-authority-v1","sourceEndpoint":{"type":"hizofs","fileSystemId":"a00000000000000000000"},"targetAuthorityIdentity":"target-authority-v1","targetEndpoint":{"type":"hizofs","fileSystemId":"b00000000000000000000"},"journalGeneration":"7","portableProgressCodec":"naidan-transition-runtime-progress-v1","portableProgressBytes":"AQID","providerCheckpointCodec":"hizofs-streaming-namespace-import-v1","providerCheckpointState":"active","providerCheckpointBytes":"BAUG"}\n',
    );
    expect(decodeTransitionProgressPlaintext({ bytes: encoded })).toEqual(payload());
  });

  it('round-trips the exact outer envelope and unsigned AAD surface', () => {
    const value = envelope();
    const encoded = encodeTransitionProgressEnvelope({ envelope: value });
    expect(decodeTransitionProgressEnvelope({ bytes: encoded })).toEqual(value);
    const { ciphertext: _ciphertext, ...unsigned } = value;
    expect(new TextDecoder().decode(encodeUnsignedTransitionProgressEnvelope({ envelope: unsigned }))).toBe(
      '{"format":"naidan-transition-progress","formatVersion":1,"copy":1,"sequence":11,"operationId":"operation000000000000","providerKind":"hizofs","authenticationFileSystemId":"b00000000000000000000","nonce":"CAgICAgICAgICAgI"}\n',
    );
  });

  it('rejects non-canonical order, generation, state, and bounds', () => {
    const valid = new TextDecoder().decode(encodeTransitionProgressPlaintext({ payload: payload() }));
    expect(() => decodeTransitionProgressPlaintext({
      bytes: new TextEncoder().encode(valid.replace(
        '"sourceAuthorityIdentity":"source-authority-v1","sourceEndpoint"',
        '"sourceEndpoint":{"type":"hizofs","fileSystemId":"a00000000000000000000"},"sourceAuthorityIdentity"',
      )),
    })).toThrow(/canonical|fields|trailing/u);
    expect(() => encodeTransitionProgressPlaintext({ payload: { ...payload(), journalGeneration: -1n } })).toThrow(/UInt64/u);
    expect(() => encodeTransitionProgressPlaintext({
      payload: { ...payload(), providerCheckpointState: 'invalid' as 'active' },
    })).toThrow(/unhandled|unsupported|state/u);
    expect(() => encodeTransitionProgressPlaintext({
      payload: { ...payload(), providerCheckpointBytes: new Uint8Array(3 * 1024 * 1024 + 1) },
    })).toThrow(/byte bound/u);
  });

  it('rejects malformed outer envelope authentication material', () => {
    expect(() => decodeTransitionProgressEnvelope({
      bytes: new TextEncoder().encode(new TextDecoder().decode(encodeTransitionProgressEnvelope({ envelope: envelope() }))
        .replace('"copy":1', '"copy":2')),
    })).toThrow(/copy/u);
    expect(() => encodeTransitionProgressEnvelope({
      envelope: { ...envelope(), ciphertext: 'AA' },
    })).toThrow(/authentication tag/u);
  });
});
