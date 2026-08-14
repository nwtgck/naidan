import { writeU64Be } from './binary/scalars';
import { encodeCryptoContext } from './crypto-context-codec';
import { encodeUtf8Strict } from './encoding/utf8';
import { HIZOFS_V1_FORMAT_CRYPTO_CONTEXTS } from './crypto-contracts';
import { HIZOFS_V1_FORMAT_CONSTANTS } from './format-constants';
import {
  assertSegmentId,
  parseCredentialSlotId,
  parseFileSystemId,
  type CredentialSlotId,
  type FileSystemId,
  type SegmentId,
} from './identifiers';
import type { PublicationSequence, UInt64, UnlockSequence } from './scalars';

const encoder = new TextEncoder();

function fileSystemIdBytes({ fileSystemId }: { fileSystemId: FileSystemId }): Uint8Array {
  parseFileSystemId({ value: fileSystemId });
  return encodeUtf8Strict({ label: 'File System ID', value: fileSystemId });
}

function credentialSlotIdBytes({ slotId }: { slotId: CredentialSlotId }): Uint8Array {
  parseCredentialSlotId({ value: slotId });
  return encodeUtf8Strict({ label: 'Credential Slot ID', value: slotId });
}

function segmentIdBytes({ segmentId }: { segmentId: SegmentId }): Uint8Array {
  assertSegmentId({ id: segmentId });
  return Uint8Array.from(segmentId);
}

function u64Bytes({ value }: { value: UInt64 }): Uint8Array {
  const bytes = new Uint8Array(8);
  writeU64Be({ bytes, offset: 0, value });
  return bytes;
}

function encodeDescriptor({ descriptor, fields }: {
  descriptor: { readonly domain: string; readonly fields: readonly string[] };
  fields: readonly Uint8Array[];
}): Uint8Array {
  if (fields.length !== descriptor.fields.length) {
    throw new RangeError(`crypto context ${descriptor.domain} requires ${descriptor.fields.length} fields`);
  }
  return encodeCryptoContext({
    domain: descriptor.domain as Parameters<typeof encodeCryptoContext>[0]['domain'],
    fields,
  });
}

export function encodePassphraseSlotKdfContext({ fileSystemId, salt, slotId }: {
  fileSystemId: FileSystemId;
  salt: Uint8Array;
  slotId: CredentialSlotId;
}): Uint8Array {
  return encodeDescriptor({
    descriptor: HIZOFS_V1_FORMAT_CRYPTO_CONTEXTS.passphraseSlotKdf,
    fields: [fileSystemIdBytes({ fileSystemId }), credentialSlotIdBytes({ slotId }), Uint8Array.from(salt)],
  });
}

export function encodeUnlockAuthenticatorKeyContext({ copy, fileSystemId, unlockSequence }: {
  copy: 0 | 1;
  fileSystemId: FileSystemId;
  unlockSequence: UnlockSequence;
}): Uint8Array {
  return encodeDescriptor({
    descriptor: HIZOFS_V1_FORMAT_CRYPTO_CONTEXTS.unlockAuthenticatorKey,
    fields: [fileSystemIdBytes({ fileSystemId }), Uint8Array.of(copy), u64Bytes({ value: unlockSequence })],
  });
}

export function encodeUnlockAuthenticatorAad({ canonicalUnsignedEnvelopeBytes }: {
  canonicalUnsignedEnvelopeBytes: Uint8Array;
}): Uint8Array {
  return encodeDescriptor({
    descriptor: HIZOFS_V1_FORMAT_CRYPTO_CONTEXTS.unlockAuthenticatorAad,
    fields: [Uint8Array.from(canonicalUnsignedEnvelopeBytes)],
  });
}

export function encodeSuperblockKeyContext({ copy, fileSystemId, publicationSequence }: {
  copy: 0 | 1;
  fileSystemId: FileSystemId;
  publicationSequence: PublicationSequence;
}): Uint8Array {
  return encodeDescriptor({
    descriptor: HIZOFS_V1_FORMAT_CRYPTO_CONTEXTS.superblockKey,
    fields: [fileSystemIdBytes({ fileSystemId }), Uint8Array.of(copy), u64Bytes({ value: publicationSequence })],
  });
}

export function encodeSuperblockAad({ exactHeader }: { exactHeader: Uint8Array }): Uint8Array {
  return encodeDescriptor({
    descriptor: HIZOFS_V1_FORMAT_CRYPTO_CONTEXTS.superblockAad,
    fields: [Uint8Array.from(exactHeader)],
  });
}

export function encodeSegmentHeaderKeyContext({ fileSystemId, physicalSegmentId, segmentClass }: {
  fileSystemId: FileSystemId;
  physicalSegmentId: SegmentId;
  segmentClass: number;
}): Uint8Array {
  return encodeDescriptor({
    descriptor: HIZOFS_V1_FORMAT_CRYPTO_CONTEXTS.segmentHeaderKey,
    fields: [fileSystemIdBytes({ fileSystemId }), segmentIdBytes({ segmentId: physicalSegmentId }), Uint8Array.of(segmentClass)],
  });
}

export function encodeSegmentHeaderAad({ fileSystemId, segmentHeaderPrefix }: {
  fileSystemId: FileSystemId;
  segmentHeaderPrefix: Uint8Array;
}): Uint8Array {
  return encodeDescriptor({
    descriptor: HIZOFS_V1_FORMAT_CRYPTO_CONTEXTS.segmentHeaderAad,
    fields: [fileSystemIdBytes({ fileSystemId }), Uint8Array.from(segmentHeaderPrefix)],
  });
}

export function encodeRecordKeyContext({ fileSystemId, homeSegmentId }: {
  fileSystemId: FileSystemId;
  homeSegmentId: SegmentId;
}): Uint8Array {
  return encodeDescriptor({
    descriptor: HIZOFS_V1_FORMAT_CRYPTO_CONTEXTS.recordKey,
    fields: [fileSystemIdBytes({ fileSystemId }), segmentIdBytes({ segmentId: homeSegmentId })],
  });
}

export type RecordAadEncoder = Readonly<{
  byteLength: number;
  encode({ completeFrameHeader }: { completeFrameHeader: Uint8Array }): Uint8Array;
  write({ bytes, completeFrameHeader }: { bytes: Uint8Array; completeFrameHeader: Uint8Array }): Uint8Array;
}>;

export function createRecordAadEncoder({ fileSystemId }: {
  fileSystemId: FileSystemId;
}): RecordAadEncoder {
  const frameHeaderBytes = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.recordFrameHeader;
  const template = encodeDescriptor({
    descriptor: HIZOFS_V1_FORMAT_CRYPTO_CONTEXTS.recordAad,
    fields: [fileSystemIdBytes({ fileSystemId }), new Uint8Array(frameHeaderBytes)],
  });
  const frameHeaderOffset = template.byteLength - frameHeaderBytes;
  const write = ({ bytes, completeFrameHeader }: { bytes: Uint8Array; completeFrameHeader: Uint8Array }): Uint8Array => {
    if (completeFrameHeader.byteLength !== frameHeaderBytes) {
      throw new RangeError("Record Frame Header must have the exact V1 byte length");
    }
    if (bytes.byteLength !== template.byteLength) {
      throw new RangeError("Record AAD destination must have the exact V1 byte length");
    }
    bytes.set(template);
    bytes.set(completeFrameHeader, frameHeaderOffset);
    return bytes;
  };
  return Object.freeze({
    byteLength: template.byteLength,
    encode: ({ completeFrameHeader }: { completeFrameHeader: Uint8Array }) => write({
      bytes: new Uint8Array(template.byteLength),
      completeFrameHeader,
    }),
    write,
  });
}

export function encodeRecordAad({ completeFrameHeader, fileSystemId }: {
  completeFrameHeader: Uint8Array;
  fileSystemId: FileSystemId;
}): Uint8Array {
  return encodeDescriptor({
    descriptor: HIZOFS_V1_FORMAT_CRYPTO_CONTEXTS.recordAad,
    fields: [fileSystemIdBytes({ fileSystemId }), completeFrameHeader],
  });
}

export function encodeSegmentFooterKeyContext({ fileSystemId, physicalSegmentId }: {
  fileSystemId: FileSystemId;
  physicalSegmentId: SegmentId;
}): Uint8Array {
  return encodeDescriptor({
    descriptor: HIZOFS_V1_FORMAT_CRYPTO_CONTEXTS.segmentFooterKey,
    fields: [fileSystemIdBytes({ fileSystemId }), segmentIdBytes({ segmentId: physicalSegmentId })],
  });
}

export function encodeSegmentFooterAad({ fileSystemId, footerHeader, footerTrailer }: {
  fileSystemId: FileSystemId;
  footerHeader: Uint8Array;
  footerTrailer: Uint8Array;
}): Uint8Array {
  return encodeDescriptor({
    descriptor: HIZOFS_V1_FORMAT_CRYPTO_CONTEXTS.segmentFooterAad,
    fields: [fileSystemIdBytes({ fileSystemId }), Uint8Array.from(footerHeader), Uint8Array.from(footerTrailer)],
  });
}

export function encodePassphraseSlotAad({
  fileSystemId,
  formatVersion,
  method,
  methodParameters,
  methodVersion,
  slotId,
}: {
  fileSystemId: FileSystemId;
  formatVersion: number;
  method: string;
  methodParameters: Uint8Array;
  methodVersion: number;
  slotId: CredentialSlotId;
}): Uint8Array {
  const versionBytes = new Uint8Array(2);
  versionBytes[0] = (formatVersion >>> 8) & 0xff;
  versionBytes[1] = formatVersion & 0xff;
  const methodVersionBytes = new Uint8Array(4);
  new DataView(methodVersionBytes.buffer).setUint32(0, methodVersion, false);
  return encodeDescriptor({
    descriptor: HIZOFS_V1_FORMAT_CRYPTO_CONTEXTS.passphraseSlotAad,
    fields: [
      versionBytes,
      fileSystemIdBytes({ fileSystemId }),
      credentialSlotIdBytes({ slotId }),
      encoder.encode(method),
      methodVersionBytes,
      Uint8Array.from(methodParameters),
    ],
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
