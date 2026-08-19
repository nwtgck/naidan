import { describe, expect, it, vi } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createHomeRecordReference,
  createUInt64,
  parseSegmentId,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import {
  AuthenticatedFileDataRecordCache,
  type AuthenticatedFileDataRecord,
} from "@/00-storage/service/hizofs/authenticated-store/file-data-record-cache";

function fileDataReference({ offset = 64n, seed = 1 }: {
  offset?: bigint;
  seed?: number;
} = {}): HomeRecordReference {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_data,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(seed) }),
  } });
}

function loadedFileData({ bytes, reference }: {
  bytes: Uint8Array;
  reference: HomeRecordReference;
}): AuthenticatedFileDataRecord {
  return { plaintext: bytes, recordKind: reference.recordKind };
}

describe("AuthenticatedFileDataRecordCache", () => {
  it("retains one authenticated File Data plaintext and copies only requested ranges", async () => {
    const reference = fileDataReference();
    const retained = Uint8Array.from({ length: 32 }, (_, index) => index);
    const load = vi.fn(async () => loadedFileData({ bytes: retained, reference }));
    const cache = new AuthenticatedFileDataRecordCache({
      diagnostics: undefined,
      policy: { maximumBytes: 64, maximumEntries: 4 },
    });
    const first = new Uint8Array(4);
    const second = new Uint8Array(3);

    await cache.copyRange({
      destination: first,
      destinationOffset: 0,
      load,
      reference,
      sourceLength: 4,
      sourceOffset: 8,
      validatePlaintextLength: ({ plaintextLength }) => expect(plaintextLength).toBe(32),
    });
    await cache.copyRange({
      destination: second,
      destinationOffset: 0,
      load,
      reference,
      sourceLength: 3,
      sourceOffset: 20,
      validatePlaintextLength: ({ plaintextLength }) => expect(plaintextLength).toBe(32),
    });

    expect(first).toEqual(new Uint8Array([8, 9, 10, 11]));
    expect(second).toEqual(new Uint8Array([20, 21, 22]));
    expect(load).toHaveBeenCalledTimes(1);
    expect(retained.some(byte => byte !== 0)).toBe(true);

    cache.dispose();
    expect(retained.every(byte => byte === 0)).toBe(true);
  });

  it("single-flights concurrent ranges for the same authenticated File Data Record", async () => {
    const reference = fileDataReference();
    const retained = Uint8Array.from({ length: 32 }, (_, index) => index);
    let resolveLoad: ((record: AuthenticatedFileDataRecord) => void) | undefined;
    const pending = new Promise<AuthenticatedFileDataRecord>(resolve => {
      resolveLoad = resolve;
    });
    const load = vi.fn(async () => await pending);
    const cache = new AuthenticatedFileDataRecordCache({
      diagnostics: undefined,
      policy: { maximumBytes: 128, maximumEntries: 4 },
    });
    const first = new Uint8Array(4);
    const second = new Uint8Array(4);

    const firstRead = cache.copyRange({
      destination: first,
      destinationOffset: 0,
      load,
      reference,
      sourceLength: 4,
      sourceOffset: 2,
      validatePlaintextLength: () => undefined,
    });
    const secondRead = cache.copyRange({
      destination: second,
      destinationOffset: 0,
      load,
      reference,
      sourceLength: 4,
      sourceOffset: 18,
      validatePlaintextLength: () => undefined,
    });
    const settleLoad = resolveLoad;
    if (settleLoad === undefined) throw new Error("File Data load did not start");
    settleLoad(loadedFileData({ bytes: retained, reference }));
    await Promise.all([firstRead, secondRead]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(first).toEqual(new Uint8Array([2, 3, 4, 5]));
    expect(second).toEqual(new Uint8Array([18, 19, 20, 21]));
    cache.dispose();
    expect(retained.every(byte => byte === 0)).toBe(true);
  });

  it("rechecks concurrent non-single-flight admissions without replacing retained plaintext", async () => {
    const reference = fileDataReference();
    const firstPlaintext = Uint8Array.from({ length: 32 }, (_, index) => index);
    const secondPlaintext = Uint8Array.from(firstPlaintext);
    let resolveFirst: ((record: AuthenticatedFileDataRecord) => void) | undefined;
    let resolveSecond: ((record: AuthenticatedFileDataRecord) => void) | undefined;
    const firstLoad = new Promise<AuthenticatedFileDataRecord>(resolve => {
      resolveFirst = resolve;
    });
    const secondLoad = new Promise<AuthenticatedFileDataRecord>(resolve => {
      resolveSecond = resolve;
    });
    const load = vi.fn()
      .mockImplementationOnce(async () => await firstLoad)
      .mockImplementationOnce(async () => await secondLoad);
    const cache = new AuthenticatedFileDataRecordCache({
      diagnostics: undefined,
      // The complete frame is larger than this budget, so pending loads are
      // intentionally not single-flighted even though the plaintext fits.
      policy: { maximumBytes: 64, maximumEntries: 4 },
    });
    const first = new Uint8Array(2);
    const second = new Uint8Array(2);

    const firstRead = cache.copyRange({
      destination: first, destinationOffset: 0, load, reference, sourceLength: 2, sourceOffset: 4,
      validatePlaintextLength: () => undefined,
    });
    const secondRead = cache.copyRange({
      destination: second, destinationOffset: 0, load, reference, sourceLength: 2, sourceOffset: 12,
      validatePlaintextLength: () => undefined,
    });
    const settleFirst = resolveFirst;
    const settleSecond = resolveSecond;
    if (settleFirst === undefined || settleSecond === undefined) throw new Error("concurrent loads did not start");
    settleFirst(loadedFileData({ bytes: firstPlaintext, reference }));
    await firstRead;
    settleSecond(loadedFileData({ bytes: secondPlaintext, reference }));
    await secondRead;

    expect(load).toHaveBeenCalledTimes(2);
    expect(first).toEqual(new Uint8Array([4, 5]));
    expect(second).toEqual(new Uint8Array([12, 13]));
    expect(firstPlaintext.some(byte => byte !== 0)).toBe(true);
    expect(secondPlaintext.every(byte => byte === 0)).toBe(true);
    cache.dispose();
    expect(firstPlaintext.every(byte => byte === 0)).toBe(true);
  });

  it("zeroizes evicted retained plaintext while keeping the byte budget bounded", async () => {
    const firstReference = fileDataReference({ seed: 1 });
    const secondReference = fileDataReference({ offset: 160n, seed: 2 });
    const firstPlaintext = new Uint8Array(8).fill(0x11);
    const secondPlaintext = new Uint8Array(8).fill(0x22);
    const cache = new AuthenticatedFileDataRecordCache({
      diagnostics: undefined,
      policy: { maximumBytes: 8, maximumEntries: 2 },
    });

    await cache.copyRange({
      destination: new Uint8Array(1),
      destinationOffset: 0,
      load: async () => loadedFileData({ bytes: firstPlaintext, reference: firstReference }),
      reference: firstReference,
      sourceLength: 1,
      sourceOffset: 0,
      validatePlaintextLength: () => undefined,
    });
    await cache.copyRange({
      destination: new Uint8Array(1),
      destinationOffset: 0,
      load: async () => loadedFileData({ bytes: secondPlaintext, reference: secondReference }),
      reference: secondReference,
      sourceLength: 1,
      sourceOffset: 0,
      validatePlaintextLength: () => undefined,
    });

    expect(firstPlaintext.every(byte => byte === 0)).toBe(true);
    expect(secondPlaintext.some(byte => byte !== 0)).toBe(true);
    cache.dispose();
    expect(secondPlaintext.every(byte => byte === 0)).toBe(true);
  });

  it("does not retain plaintext that exceeds the cache byte budget", async () => {
    const reference = fileDataReference();
    const loaded: Uint8Array[] = [];
    const load = vi.fn(async () => {
      const plaintext = new Uint8Array(8).fill(0x33);
      loaded.push(plaintext);
      return loadedFileData({ bytes: plaintext, reference });
    });
    const cache = new AuthenticatedFileDataRecordCache({
      diagnostics: undefined,
      policy: { maximumBytes: 4, maximumEntries: 4 },
    });

    for (let index = 0; index < 2; index += 1) {
      const output = new Uint8Array(2);
      await cache.copyRange({
        destination: output,
        destinationOffset: 0,
        load,
        reference,
        sourceLength: 2,
        sourceOffset: 1,
        validatePlaintextLength: () => undefined,
      });
      expect(output).toEqual(new Uint8Array([0x33, 0x33]));
    }

    expect(load).toHaveBeenCalledTimes(2);
    expect(loaded.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
  });

  it("zeroizes and rejects a loaded record with the wrong Record Kind", async () => {
    const reference = fileDataReference();
    const plaintext = new Uint8Array(8).fill(0x44);
    const cache = new AuthenticatedFileDataRecordCache({
      diagnostics: undefined,
      policy: { maximumBytes: 64, maximumEntries: 4 },
    });

    await expect(cache.copyRange({
      destination: new Uint8Array(1),
      destinationOffset: 0,
      load: async () => ({
        plaintext,
        recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_extent_page,
      }),
      reference,
      sourceLength: 1,
      sourceOffset: 0,
      validatePlaintextLength: () => undefined,
    })).rejects.toThrow("wrong Record Kind");
    expect(plaintext.every(byte => byte === 0)).toBe(true);
  });
});
