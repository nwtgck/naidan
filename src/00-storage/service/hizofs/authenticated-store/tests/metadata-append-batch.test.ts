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
      policy: { maximumBytes: 0, maximumEntries: 0 },
    });
    const batch = new AuthenticatedMetadataAppendBatch({ mutationCache, writer });
    const appendTarget = batch.appendTarget();
    const recordKind = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page;
    const first = await appendTarget.append({ records: [encodedHizoFSRecord({
      plaintext: new Uint8Array([1]),
      recordKind,
    })] });
    const firstReference = first[0]?.physicalReference;
    if (firstReference === undefined) throw new Error("first metadata append preview is missing");

    const recordsThatExceedBatchByteLimit = Array.from({ length: 16 }, (_, index) => encodedHizoFSRecord({
      plaintext: new Uint8Array(HIZOFS_V1_FORMAT_CONSTANTS.limits.metadataPlaintextBytes).fill(index + 1),
      recordKind,
    }));
    await expect(appendTarget.append({ records: recordsThatExceedBatchByteLimit })).rejects.toBeInstanceOf(
      AuthenticatedMetadataAppendBatchFlushRequiredError,
    );

    const retried = await appendTarget.append({ records: [encodedHizoFSRecord({
      plaintext: new Uint8Array([2]),
      recordKind,
    })] });
    const retriedReference = retried[0]?.physicalReference;
    if (retriedReference === undefined) throw new Error("retried metadata append preview is missing");
    expect(retriedReference.byteOffset).toBe(
      firstReference.byteOffset + BigInt(firstReference.frameLength),
    );

    await batch.flush();
    mutationCache.dispose();
    writer.abandon();
    await writer.settleAbandonment();
    rootKey.destroy();
  });
});
