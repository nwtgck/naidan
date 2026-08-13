import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseFileSystemId,
} from "@/00-storage/service/hizofs/00-format";
import { generateFileSystemRootKey, type RandomByteSource } from "@/00-storage/service/hizofs/01-crypto";
import {
  AuthenticatedMetadataAppendBatch,
  AuthenticatedMetadataAppendBatchFlushRequiredError,
} from "@/00-storage/service/hizofs/authenticated-store/metadata-append-batch";
import { AuthenticatedMetadataRecordCache } from "@/00-storage/service/hizofs/authenticated-store/metadata-record-cache";
import type { AuthenticatedHizoFSPhysicalBytes } from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import {
  createAuthenticatedSegmentWriter,
  encodedHizoFSRecord,
} from "@/00-storage/service/hizofs/authenticated-store/record-appender";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";
import { describe, expect, it } from "vitest";

function deterministicRandomSource(): RandomByteSource {
  let next = 1;
  return ({ bytes }) => {
    for (let index = 0; index < bytes.byteLength; index += 1) {
      bytes[index] = next;
      next = next === 251 ? 1 : next + 1;
    }
  };
}

describe("authenticated metadata append batch", () => {
  it("does not advance its preview tail when a staged record set requires a flush", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const writer = await createAuthenticatedSegmentWriter({
      backend,
      fileSystemId,
      randomSource,
      rootKey,
      segmentClass: "metadata",
    });
    const mutationCache = new AuthenticatedMetadataRecordCache({
      diagnosticScope: "mutation",
      diagnostics: undefined,
      policy: { maximumBytes: 1024, maximumEntries: 8 },
    });
    const batch = new AuthenticatedMetadataAppendBatch({ mutationCache, writer });
    const appendTarget = batch.appendTarget();
    const recordKind = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page;
    const firstPlaintext = new Uint8Array([1]);
    const firstAppend = appendTarget.appendCallerOwnedRecord({ plaintext: firstPlaintext, recordKind });
    firstPlaintext[0] = 9;
    const first = await firstAppend;
    const firstReference = first.physicalReference;
    if (first.type !== "home") throw new Error("first metadata append preview is not a Home Record");
    const cachedFirst = await mutationCache.read({
      load: async () => {
        throw new Error("staged metadata plaintext was not retained");
      },
      reference: first.homeReference,
    });
    expect([...cachedFirst.plaintext]).toEqual([1]);
    cachedFirst.plaintext.fill(0);

    const recordsThatExceedBatchByteLimit = Array.from({ length: 16 }, (_, index) => encodedHizoFSRecord({
      plaintext: new Uint8Array(HIZOFS_V1_FORMAT_CONSTANTS.limits.metadataPlaintextBytes).fill(index + 1),
      recordKind,
    }));
    await expect(appendTarget.append({ records: recordsThatExceedBatchByteLimit })).rejects.toBeInstanceOf(
      AuthenticatedMetadataAppendBatchFlushRequiredError,
    );

    const retried = await appendTarget.appendCallerOwnedRecord({
      plaintext: new Uint8Array([2]),
      recordKind,
    });
    const retriedReference = retried.physicalReference;
    expect(retriedReference.byteOffset).toBe(
      firstReference.byteOffset + BigInt(firstReference.frameLength),
    );

    const ownedPlaintext = appendTarget.encodeOwnedRecordPayload({
      encode: () => new Uint8Array([3, 4, 5]),
    });
    await appendTarget.appendOwnedRecord({ plaintext: ownedPlaintext, recordKind });
    expect([...ownedPlaintext]).toEqual([3, 4, 5]);

    const rejectedOwnedPlaintext = appendTarget.encodeOwnedRecordPayload({
      encode: () => new Uint8Array([6, 7, 8]),
    });
    await expect(appendTarget.appendOwnedRecord({
      plaintext: rejectedOwnedPlaintext,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_data,
    })).rejects.toThrow("segment class");
    expect([...rejectedOwnedPlaintext]).toEqual([0, 0, 0]);

    await batch.flush();
    expect([...ownedPlaintext]).toEqual([0, 0, 0]);
    mutationCache.dispose();
    writer.abandon();
    await writer.settleAbandonment();
    rootKey.destroy();
  });
});
