import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseFileSystemId,
} from "@/00-storage/service/hizofs/00-format";
import { generateFileSystemRootKey, type RandomByteSource } from "@/00-storage/service/hizofs/01-crypto";
import { DeterministicPhysicalStoreFaultInjector } from "@/00-storage/service/hizofs/physical-store/testing/deterministic-fault-injector";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedHizoFSPhysicalBytes } from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import {
  readAuthenticatedHomeRecord,
  readAuthenticatedPhysicalRecord,
} from "@/00-storage/service/hizofs/authenticated-store/record-reader";
import { createAuthenticatedSegmentWriter, encodedHizoFSRecord } from "@/00-storage/service/hizofs/authenticated-store/record-appender";
import { readAuthenticatedSegmentIndex } from "@/00-storage/service/hizofs/authenticated-store/segment-footer-store";
import type {
  AuthenticatedCryptoDiagnosticsObservation,
  AuthenticatedPhysicalAccessReasonObservation,
  AuthenticatedRecordDiagnosticsObservation,
} from "@/00-storage/service/hizofs/authenticated-store/diagnostics-hooks";


class FileSizeBlockingBackend extends InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes> {
  private blockNextFileSizeValue = false;
  private readonly fileSizeStarted: Promise<void>;
  private fileSizeStartedResolve: (() => void) | undefined;
  private readonly releaseFileSizeValue: Promise<void>;
  private releaseFileSizeResolve: (() => void) | undefined;

  public constructor() {
    super({});
    this.fileSizeStarted = new Promise(resolve => {
      this.fileSizeStartedResolve = resolve;
    });
    this.releaseFileSizeValue = new Promise(resolve => {
      this.releaseFileSizeResolve = resolve;
    });
  }

  public blockNextFileSize(): void {
    this.blockNextFileSizeValue = true;
  }
  public async waitForFileSize(): Promise<void> {
    await this.fileSizeStarted;
  }
  public releaseFileSize(): void {
    this.releaseFileSizeResolve?.();
  }

  public override async getOpenFileSize(
    input: Parameters<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["getOpenFileSize"]>[0],
  ): Promise<bigint> {
    if (this.blockNextFileSizeValue) {
      this.blockNextFileSizeValue = false;
      this.fileSizeStartedResolve?.();
      await this.releaseFileSizeValue;
    }
    return await super.getOpenFileSize(input);
  }
}


class SealReadCountingBackend extends InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes> {
  public readExactOperations = 0;
  public readExactWithFileSizeOperations = 0;
  public reportExtraFileByte = false;
  public corruptNextReadExact = false;

  public resetSealReadCounters(): void {
    this.readExactOperations = 0;
    this.readExactWithFileSizeOperations = 0;
  }

  public override async getFileSize(
    input: Parameters<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["getFileSize"]>[0],
  ): Promise<bigint | undefined> {
    const size = await super.getFileSize(input);
    return size === undefined || !this.reportExtraFileByte ? size : size + 1n;
  }

  public override async readExact(
    input: Parameters<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["readExact"]>[0],
  ): Promise<Uint8Array> {
    this.readExactOperations += 1;
    const bytes = await super.readExact(input);
    if (!this.corruptNextReadExact) return bytes;
    this.corruptNextReadExact = false;
    const corrupted = Uint8Array.from(bytes);
    if (corrupted.byteLength === 0) throw new Error("cannot corrupt an empty exact read");
    corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
    return corrupted;
  }

  public override async readExactWithFileSize(
    input: Parameters<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["readExactWithFileSize"]>[0],
  ): Promise<Readonly<{ bytes: Uint8Array; fileSize: bigint }>> {
    this.readExactWithFileSizeOperations += 1;
    return await super.readExactWithFileSize(input);
  }
}

class PhysicalAccessRecordingBackend extends InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes> {
  readonly events: string[] = [];

  public override async getFileSize(
    input: Parameters<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["getFileSize"]>[0],
  ): Promise<bigint | undefined> {
    this.events.push(`size:${input.path}`);
    return await super.getFileSize(input);
  }

  public override async getOpenFileSize(
    input: Parameters<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["getOpenFileSize"]>[0],
  ): Promise<bigint> {
    this.events.push(`open-size:${input.file.path}`);
    return await super.getOpenFileSize(input);
  }

  public override async createFileExclusive(
    input: Parameters<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["createFileExclusive"]>[0],
  ): ReturnType<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["createFileExclusive"]> {
    this.events.push(`create:${input.path}`);
    return await super.createFileExclusive(input);
  }

  public override async writeAt(
    input: Parameters<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["writeAt"]>[0],
  ): Promise<void> {
    this.events.push(`write:${input.file.path}`);
    await super.writeAt(input);
  }
}

function repeatedThenFreshSegmentSource(): RandomByteSource {
  let call = 0;
  return ({ bytes }) => {
    bytes.fill(call === 0 ? 7 : 8);
    call += 1;
  };
}

class DurabilityBlockingBackend extends InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes> {
  private blockNextDurabilityValue = false;
  private readonly durabilityStarted: Promise<void>;
  private durabilityStartedResolve: (() => void) | undefined;
  private readonly releaseDurabilityValue: Promise<void>;
  private releaseDurabilityResolve: (() => void) | undefined;

  public constructor() {
    super({});
    this.durabilityStarted = new Promise(resolve => {
      this.durabilityStartedResolve = resolve;
    });
    this.releaseDurabilityValue = new Promise(resolve => {
      this.releaseDurabilityResolve = resolve;
    });
  }

  public blockNextDurability(): void {
    this.blockNextDurabilityValue = true;
  }

  public async waitForDurability(): Promise<void> {
    await this.durabilityStarted;
  }

  public releaseDurability(): void {
    this.releaseDurabilityResolve?.();
  }

  public override async syncFileData(
    input: Parameters<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["syncFileData"]>[0],
  ): Promise<void> {
    if (this.blockNextDurabilityValue) {
      this.blockNextDurabilityValue = false;
      this.durabilityStartedResolve?.();
      await this.releaseDurabilityValue;
    }
    await super.syncFileData(input);
  }
}

function deterministicRandomSource(): RandomByteSource {
  let next = 1;
  return ({ bytes }) => {
    for (let index = 0; index < bytes.byteLength; index += 1) {
      bytes[index] = next;
      next = next === 251 ? 1 : next + 1;
    }
  };
}

function fixture({ faultInjector }: { faultInjector?: DeterministicPhysicalStoreFaultInjector } = {}) {
  const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({ faultInjector });
  const randomSource = deterministicRandomSource();
  const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
  const rootKey = generateFileSystemRootKey({ randomSource });
  return { backend, fileSystemId, randomSource, rootKey };
}

describe("authenticated record appender", () => {
  it("subtracts the same-class preflight probe and lets exclusive creation claim the target path", async () => {
    const backend = new PhysicalAccessRecordingBackend({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });

    await createAuthenticatedSegmentWriter({
      backend,
      fileSystemId,
      randomSource,
      rootKey,
      segmentClass: "metadata",
    });

    const firstCreateIndex = backend.events.findIndex(event => event.startsWith("create:"));
    const preflightSizes = backend.events.slice(0, firstCreateIndex).filter(event => event.startsWith("size:"));
    expect(preflightSizes).toHaveLength(1);
    expect(preflightSizes[0]).toContain("/data/");
    rootKey.destroy();
  });

  it("checks the trusted append tail through the owned writable capability", async () => {
    const backend = new PhysicalAccessRecordingBackend({});
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
    backend.events.length = 0;

    await writer.append({ records: [encodedHizoFSRecord({
      plaintext: new Uint8Array([1]),
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    })] });

    expect(backend.events.filter(event => event.startsWith("open-size:"))).toHaveLength(1);
    expect(backend.events.filter(event => event.startsWith("size:"))).toHaveLength(0);
    writer.abandon();
    await writer.settleAbandonment();
    rootKey.destroy();
  });

  it("derives one Record Key for a multi-record append batch", async () => {
    const { backend, fileSystemId, randomSource, rootKey } = fixture();
    const writer = await createAuthenticatedSegmentWriter({
      backend,
      fileSystemId,
      randomSource,
      rootKey,
      segmentClass: "metadata",
    });
    const deriveKey = vi.spyOn(globalThis.crypto.subtle, "deriveKey");

    try {
      deriveKey.mockClear();
      await writer.append({ records: [
        encodedHizoFSRecord({
          plaintext: new Uint8Array([1]),
          recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
        }),
        encodedHizoFSRecord({
          plaintext: new Uint8Array([2]),
          recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
        }),
      ] });

      expect(deriveKey).toHaveBeenCalledTimes(1);
    } finally {
      deriveKey.mockRestore();
      writer.abandon();
      await writer.settleAbandonment();
      rootKey.destroy();
    }
  });

  it("bounds overlapping Record encryption while preserving append order", async () => {
    const { backend, fileSystemId, randomSource, rootKey } = fixture();
    const writer = await createAuthenticatedSegmentWriter({
      backend,
      fileSystemId,
      randomSource,
      rootKey,
      segmentClass: "metadata",
    });
    const originalEncrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle);
    const encrypt = vi.spyOn(globalThis.crypto.subtle, "encrypt");
    let active = 0;
    let callCount = 0;
    let maximumActive = 0;
    let releaseOverlap: (() => void) | undefined;
    const overlap = new Promise<void>(resolve => {
      releaseOverlap = resolve;
    });
    encrypt.mockImplementation(async (algorithm, key, data) => {
      callCount += 1;
      if (callCount === 1) return await originalEncrypt(algorithm, key, data);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (active === 4) releaseOverlap?.();
      await overlap;
      try {
        return await originalEncrypt(algorithm, key, data);
      } finally {
        active -= 1;
      }
    });

    try {
      const results = await writer.append({ records: Array.from({ length: 9 }, (_, index) => encodedHizoFSRecord({
        plaintext: Uint8Array.of(index + 1),
        recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
      })) });

      expect(maximumActive).toBe(4);
      for (let index = 1; index < results.length; index += 1) {
        const previous = results[index - 1];
        const current = results[index];
        if (previous?.type !== "home" || current?.type !== "home") throw new Error("expected home records");
        expect(current.homeReference.byteOffset).toBe(
          previous.homeReference.byteOffset + BigInt(previous.homeReference.frameLength),
        );
      }
    } finally {
      encrypt.mockRestore();
      writer.abandon();
      await writer.settleAbandonment();
      rootKey.destroy();
    }
  });

  it("settles in-flight Record encryption before rejecting without physical append", async () => {
    const backend = new PhysicalAccessRecordingBackend({});
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
    const originalEncrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle);
    const encrypt = vi.spyOn(globalThis.crypto.subtle, "encrypt");
    let callCount = 0;
    encrypt.mockImplementation(async (algorithm, key, data) => {
      callCount += 1;
      if (callCount === 2) throw new Error("injected Record encryption failure");
      return await originalEncrypt(algorithm, key, data);
    });
    backend.events.length = 0;

    try {
      await expect(writer.append({ records: Array.from({ length: 6 }, (_, index) => encodedHizoFSRecord({
        plaintext: Uint8Array.of(index + 1),
        recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
      })) })).rejects.toThrow("injected Record encryption failure");
      expect(backend.events.filter(event => event.startsWith("write:"))).toHaveLength(0);
      expect(writer.state).toBe("active");
    } finally {
      encrypt.mockRestore();
      writer.abandon();
      await writer.settleAbandonment();
      rootKey.destroy();
    }
  });

  it("keeps the writer reusable when a later Record nonce preparation fails", async () => {
    const backend = new PhysicalAccessRecordingBackend({});
    let randomCalls = 0;
    let failAt: number | undefined;
    const randomSource: RandomByteSource = ({ bytes }) => {
      randomCalls += 1;
      if (randomCalls === failAt) throw new Error("injected Record nonce failure");
      bytes.fill((randomCalls % 251) + 1);
    };
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const writer = await createAuthenticatedSegmentWriter({
      backend,
      fileSystemId,
      randomSource,
      rootKey,
      segmentClass: "metadata",
    });
    const encrypt = vi.spyOn(globalThis.crypto.subtle, "encrypt");
    encrypt.mockClear();
    backend.events.length = 0;

    try {
      failAt = randomCalls + 2;
      await expect(writer.append({ records: [
        encodedHizoFSRecord({
          plaintext: Uint8Array.of(1),
          recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
        }),
        encodedHizoFSRecord({
          plaintext: Uint8Array.of(2),
          recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
        }),
      ] })).rejects.toThrow("injected Record nonce failure");

      expect(encrypt).toHaveBeenCalledTimes(1);
      expect(backend.events.filter(event => event.startsWith("write:"))).toHaveLength(0);
      expect(writer.state).toBe("active");

      failAt = undefined;
      await expect(writer.append({ records: [encodedHizoFSRecord({
        plaintext: Uint8Array.of(3),
        recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
      })] })).resolves.toHaveLength(1);
    } finally {
      encrypt.mockRestore();
      writer.abandon();
      await writer.settleAbandonment();
      rootKey.destroy();
    }
  });

  it("retries a same-class Segment ID collision through exclusive creation", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource: deterministicRandomSource() });
    const repeatedSource: RandomByteSource = ({ bytes }) => bytes.fill(7);
    const existing = await createAuthenticatedSegmentWriter({
      backend,
      fileSystemId,
      randomSource: repeatedSource,
      rootKey,
      segmentClass: "metadata",
    });
    const retried = await createAuthenticatedSegmentWriter({
      backend,
      fileSystemId,
      randomSource: repeatedThenFreshSegmentSource(),
      rootKey,
      segmentClass: "metadata",
    });

    expect(retried.physicalSegmentId).not.toEqual(existing.physicalSegmentId);
    expect(backend.openHandleCount()).toBe(0);
    rootKey.destroy();
  });

  it("keeps the opposite-class preflight for the global Segment ID space", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource: deterministicRandomSource() });
    const repeatedSource: RandomByteSource = ({ bytes }) => bytes.fill(7);
    const metadata = await createAuthenticatedSegmentWriter({
      backend,
      fileSystemId,
      randomSource: repeatedSource,
      rootKey,
      segmentClass: "metadata",
    });
    const data = await createAuthenticatedSegmentWriter({
      backend,
      fileSystemId,
      randomSource: repeatedThenFreshSegmentSource(),
      rootKey,
      segmentClass: "data",
    });

    expect(data.physicalSegmentId).not.toEqual(metadata.physicalSegmentId);
    expect(backend.openHandleCount()).toBe(0);
    rootKey.destroy();
  });

  it("reports each successfully persisted record through the authenticated diagnostics port", async () => {
    const value = fixture();
    const cryptoObservations: AuthenticatedCryptoDiagnosticsObservation[] = [];
    const observations: AuthenticatedRecordDiagnosticsObservation[] = [];
    const writer = await createAuthenticatedSegmentWriter({
      ...value,
      diagnostics: {
        recordCodecOperation: () => {},
        recordCryptoOperation: observation => cryptoObservations.push(observation),
        recordPublicationOperation: () => {},
        recordPersistedRecord: observation => observations.push(observation),
      },
      segmentClass: "metadata",
    });
    const results = await writer.append({ records: [
      encodedHizoFSRecord({
        plaintext: new Uint8Array([1, 2, 3]),
        recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      }),
      encodedHizoFSRecord({
        plaintext: new Uint8Array([4, 5]),
        recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
      }),
    ] });

    expect(cryptoObservations.map(({ operation }) => operation)).toEqual(["encrypt", "decrypt", "encrypt", "encrypt"]);
    expect(cryptoObservations.every(({ durationMs }) => Number.isFinite(durationMs) && durationMs >= 0)).toBe(true);
    expect(observations).toEqual(results.map((result, index) => ({
      operation: "write",
      physicalBytes: result.physicalReference.frameLength,
      plaintextBytes: index === 0 ? 3 : 2,
      recordKind: result.physicalReference.recordKind,
    })));
    value.rootKey.destroy();
  });

  it("previews exact references without mutating writer state", async () => {
    const value = fixture();
    const writer = await createAuthenticatedSegmentWriter({ ...value, segmentClass: "metadata" });
    const records = [
      encodedHizoFSRecord({
        plaintext: new Uint8Array([1, 2, 3]),
        recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      }),
      encodedHizoFSRecord({
        plaintext: new Uint8Array([4, 5]),
        recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
      }),
    ];

    const preview = writer.previewAppend({ records });

    expect(writer.persistedFrameBytes()).toBe(0);
    const actual = await writer.append({ records });
    expect(actual).toEqual(preview);
    expect(writer.persistedFrameBytes()).toBeGreaterThan(0);
    value.rootKey.destroy();
  });

  it("plans an incremental preview without replanning the already-predicted prefix", async () => {
    const value = fixture();
    const writer = await createAuthenticatedSegmentWriter({ ...value, segmentClass: "metadata" });
    const first = encodedHizoFSRecord({
      plaintext: new Uint8Array([1, 2, 3]),
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    });
    const second = encodedHizoFSRecord({
      plaintext: new Uint8Array([4, 5]),
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    });
    const expected = writer.previewAppend({ records: [first, second] });
    const planner = writer.createAppendPreviewPlanner();

    expect(() => planner.previewAppend({
      acceptPreview: () => {
        throw new Error("reject preview");
      },
      records: [first],
    })).toThrow("reject preview");
    const plannedFirst = planner.previewAppend({ acceptPreview: () => {}, records: [first] });
    const plannedSecond = planner.previewAppend({ acceptPreview: () => {}, records: [second] });

    expect([...plannedFirst, ...plannedSecond]).toEqual(expected);
    expect(writer.persistedFrameBytes()).toBe(0);
    const actual = await writer.append({ records: [first, second] });
    expect(actual).toEqual(expected);
    expect(() => planner.previewAppend({ acceptPreview: () => {}, records: [first] })).toThrow("stale");
    value.rootKey.destroy();
  });

  it("creates a fresh writer, durably appends a bounded batch, reads it, and seals it", async () => {
    const value = fixture();
    const writer = await createAuthenticatedSegmentWriter({ ...value, segmentClass: "metadata" });
    const results = await writer.append({ records: [
      encodedHizoFSRecord({ plaintext: new Uint8Array([1, 2, 3]), recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page }),
      encodedHizoFSRecord({ plaintext: new Uint8Array([4, 5]), recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit }),
    ] });
    expect(results).toHaveLength(2);
    expect(results[0]?.type).toBe("home");
    expect(results[1]?.type).toBe("home");
    if (results[0]?.type !== "home" || results[1]?.type !== "home") throw new Error("expected home records");
    expect(results[1].homeReference.byteOffset).toBe(
      results[0].homeReference.byteOffset + BigInt(results[0].homeReference.frameLength),
    );
    await expect(readAuthenticatedHomeRecord({
      backend: value.backend,
      fileSystemId: value.fileSystemId,
      homeReference: results[0].homeReference,
      rootKey: value.rootKey,
    })).resolves.toMatchObject({ plaintext: new Uint8Array([1, 2, 3]) });
    await expect(writer.seal()).resolves.toBeUndefined();
    expect(writer.state).toBe("sealed");
    await expect(writer.append({ records: [
      encodedHizoFSRecord({ plaintext: new Uint8Array(), recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit }),
    ] })).rejects.toThrow("sealed");
    expect(value.backend.openHandleCount()).toBe(0);
    value.rootKey.destroy();
  });

  it("seals an active writer from its durable append index without rescanning Record Frames", async () => {
    const backend = new SealReadCountingBackend({});
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const physicalAccessReasons: AuthenticatedPhysicalAccessReasonObservation[] = [];
    const writer = await createAuthenticatedSegmentWriter({
      backend,
      diagnostics: {
        recordCodecOperation: () => {},
        recordCryptoOperation: () => {},
        recordPersistedRecord: () => {},
        recordPhysicalAccessReason: observation => physicalAccessReasons.push(observation),
        recordPublicationOperation: () => {},
      },
      fileSystemId,
      randomSource,
      rootKey,
      segmentClass: "metadata",
    });
    const records = Array.from({ length: 64 }, (_, index) => encodedHizoFSRecord({
      plaintext: Uint8Array.of(index),
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    }));
    await writer.append({ records });

    backend.resetSealReadCounters();
    physicalAccessReasons.length = 0;
    await writer.seal();

    expect(writer.state).toBe("sealed");
    expect(backend.readExactWithFileSizeOperations).toBe(0);
    expect(backend.readExactOperations).toBe(1);
    expect(physicalAccessReasons).toContainEqual(expect.objectContaining({
      operation: "read_exact",
      reason: "segment_footer_read_back",
    }));

    const reopened = await readAuthenticatedSegmentIndex({
      backend,
      fileSystemId,
      physicalSegmentId: writer.physicalSegmentId,
      rootKey,
      segmentClass: "metadata",
    });
    expect(reopened).toMatchObject({ state: "sealed" });
    expect(reopened.frames).toHaveLength(records.length);
    rootKey.destroy();
  });

  it("rejects active-writer sealing when the trusted tail changed", async () => {
    const backend = new SealReadCountingBackend({});
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
    await writer.append({ records: [encodedHizoFSRecord({
      plaintext: Uint8Array.of(1),
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    })] });
    backend.reportExtraFileByte = true;

    await expect(writer.seal()).rejects.toThrow("changed while preparing its footer");
    expect(writer.state).toBe("abandoned");
    rootKey.destroy();
  });

  it("does not report active-writer seal success when Footer read-back differs", async () => {
    const backend = new SealReadCountingBackend({});
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
    await writer.append({ records: [encodedHizoFSRecord({
      plaintext: Uint8Array.of(1),
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    })] });
    backend.corruptNextReadExact = true;

    await expect(writer.seal()).rejects.toThrow("Footer durable read-back differs");
    expect(writer.state).toBe("abandoned");
    rootKey.destroy();
  });

  it("returns only a Physical Reference for a physical-only Relocation Index record", async () => {
    const value = fixture();
    const writer = await createAuthenticatedSegmentWriter({ ...value, segmentClass: "metadata" });
    const [result] = await writer.append({ records: [encodedHizoFSRecord({
      plaintext: new Uint8Array([7, 8, 9]),
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page,
    })] });
    expect(result?.type).toBe("physical_only");
    if (result?.type !== "physical_only") throw new Error("expected a physical-only record");
    const read = await readAuthenticatedPhysicalRecord({
      backend: value.backend,
      expectedIdentity: { type: "physical_only" },
      fileSystemId: value.fileSystemId,
      physicalReference: result.physicalReference,
      rootKey: value.rootKey,
    });
    expect(read.header.flags).toBe(HIZOFS_V1_FORMAT_CONSTANTS.flags.recordPhysicalOnly);
    expect(read.plaintext).toEqual(new Uint8Array([7, 8, 9]));
    value.rootKey.destroy();
  });

  it("snapshots caller-owned record bytes before its first asynchronous step", async () => {
    const value = fixture();
    const writer = await createAuthenticatedSegmentWriter({ ...value, segmentClass: "metadata" });
    const record = encodedHizoFSRecord({
      plaintext: new Uint8Array([1, 2, 3]),
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    });
    const append = writer.append({ records: [record] });
    record.plaintext[0] = 9;
    const [result] = await append;
    if (result?.type !== "home") throw new Error("expected a home record");
    await expect(readAuthenticatedHomeRecord({
      backend: value.backend,
      fileSystemId: value.fileSystemId,
      homeReference: result.homeReference,
      rootKey: value.rootKey,
    })).resolves.toMatchObject({ plaintext: new Uint8Array([1, 2, 3]) });
    value.rootKey.destroy();
  });

  it("rejects nonce reuse across append batches", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const repeatedNonceSource: RandomByteSource = ({ bytes }) => bytes.fill(7);
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource: deterministicRandomSource() });
    const writer = await createAuthenticatedSegmentWriter({
      backend,
      fileSystemId,
      randomSource: repeatedNonceSource,
      rootKey,
      segmentClass: "metadata",
    });
    const record = encodedHizoFSRecord({
      plaintext: new Uint8Array([1]),
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    });

    await expect(writer.append({ records: [record] })).resolves.toHaveLength(1);
    await expect(writer.append({ records: [record] })).rejects.toThrow("collision retry bound");
    expect(writer.state).toBe("active");
    rootKey.destroy();
  });

  it("rejects empty sealing before changing the writer state", async () => {
    const value = fixture();
    const writer = await createAuthenticatedSegmentWriter({ ...value, segmentClass: "metadata" });
    await expect(writer.seal()).rejects.toThrow("empty");
    expect(writer.state).toBe("active");
    value.rootKey.destroy();
  });

  it("rejects oversized caller bytes before attempting to copy them", async () => {
    const value = fixture();
    const writer = await createAuthenticatedSegmentWriter({ ...value, segmentClass: "metadata" });
    const oversizedPlaintext = new Proxy(new Uint8Array(), {
      get(target, property, receiver) {
        if (property === "byteLength") {
          return HIZOFS_V1_FORMAT_CONSTANTS.limits.metadataPlaintextBytes + 1;
        }
        if (property === "length" || property === Symbol.iterator) {
          throw new Error("rejected plaintext must not be copied");
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => encodedHizoFSRecord({
      plaintext: oversizedPlaintext,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    })).toThrow("plaintext exceeds");
    expect(writer.state).toBe("active");
    value.rootKey.destroy();
  });

  it("rejects a wrong segment class before changing the trusted tail", async () => {
    const value = fixture();
    const writer = await createAuthenticatedSegmentWriter({ ...value, segmentClass: "metadata" });
    await expect(writer.append({ records: [
      encodedHizoFSRecord({ plaintext: new Uint8Array([1]), recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_data }),
    ] })).rejects.toThrow("segment class");
    expect(writer.state).toBe("active");
    value.rootKey.destroy();
  });

  it("rejects concurrent append and seal operations on the same writer", async () => {
    const value = fixture();
    const writer = await createAuthenticatedSegmentWriter({ ...value, segmentClass: "metadata" });
    const record = encodedHizoFSRecord({
      plaintext: new Uint8Array([1]),
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    });
    const firstAppend = writer.append({ records: [record] });
    await expect(writer.append({ records: [record] })).rejects.toThrow("already in progress");
    await expect(writer.seal()).rejects.toThrow("already in progress");
    await expect(firstAppend).resolves.toHaveLength(1);
    expect(writer.state).toBe("active");
    value.rootKey.destroy();
  });

  it("does not perform physical append after explicit abandonment during preparation", async () => {
    const value = fixture();
    const writer = await createAuthenticatedSegmentWriter({ ...value, segmentClass: "metadata" });
    const record = encodedHizoFSRecord({
      plaintext: new Uint8Array([1]),
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    });
    const append = writer.append({ records: [record] });
    writer.abandon();
    await expect(append).rejects.toThrow("abandoned during append preparation");
    expect(writer.state).toBe("abandoned");
    expect(value.backend.openHandleCount()).toBe(0);
    value.rootKey.destroy();
  });


  it("does not append after ownership is revoked during trusted-tail inspection", async () => {
    const backend = new FileSizeBlockingBackend();
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const writer = await createAuthenticatedSegmentWriter({ backend, fileSystemId, randomSource, rootKey, segmentClass: "metadata" });
    const record = encodedHizoFSRecord({
      plaintext: new Uint8Array([1]),
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    });

    backend.blockNextFileSize();
    const append = writer.append({ records: [record] });
    await backend.waitForFileSize();
    writer.abandon();
    backend.releaseFileSize();

    await expect(append).rejects.toThrow("abandoned while checking");
    expect(writer.state).toBe("abandoned");
    expect(backend.openHandleCount()).toBe(0);
    rootKey.destroy();
  });

  it("keeps the writer abandoned when ownership is revoked during physical append", async () => {
    const backend = new DurabilityBlockingBackend();
    const randomSource = deterministicRandomSource();
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const rootKey = generateFileSystemRootKey({ randomSource });
    const writer = await createAuthenticatedSegmentWriter({ backend, fileSystemId, randomSource, rootKey, segmentClass: "metadata" });
    const record = encodedHizoFSRecord({
      plaintext: new Uint8Array([1]),
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    });

    backend.blockNextDurability();
    const append = writer.append({ records: [record] });
    await backend.waitForDurability();
    writer.abandon();
    backend.releaseDurability();

    await expect(append).rejects.toThrow("explicitly abandoned during append");
    expect(writer.state).toBe("abandoned");
    await expect(writer.append({ records: [record] })).rejects.toThrow("abandoned");
    expect(backend.openHandleCount()).toBe(0);
    rootKey.destroy();
  });

  it("does not report seal success to an owner revoked during Footer publication", async () => {
    const backend = new DurabilityBlockingBackend();
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
    await writer.append({ records: [encodedHizoFSRecord({
      plaintext: new Uint8Array([1]),
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    })] });

    backend.blockNextDurability();
    const seal = writer.seal();
    await backend.waitForDurability();
    writer.abandon();
    backend.releaseDurability();

    await expect(seal).rejects.toThrow("explicitly abandoned during seal");
    expect(writer.state).toBe("sealed");
    expect(backend.openHandleCount()).toBe(0);
    rootKey.destroy();
  });

  it("keeps a writer reusable when trusted-tail size observation fails before mutation", async () => {
    const injector = new DeterministicPhysicalStoreFaultInjector({
      schedule: [{ occurrence: 1, operation: "getOpenFileSize", timing: "before" }],
    });
    const value = fixture({ faultInjector: injector });
    const writer = await createAuthenticatedSegmentWriter({ ...value, segmentClass: "metadata" });
    const record = encodedHizoFSRecord({
      plaintext: new Uint8Array([1]),
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    });

    await expect(writer.append({ records: [record] })).rejects.toThrow("injected");
    expect(writer.state).toBe("active");
    expect(value.backend.openHandleCount()).toBe(0);
    injector.assertExhausted();
    await expect(writer.append({ records: [record] })).resolves.toHaveLength(1);
    writer.abandon();
    await writer.settleAbandonment();
    expect(value.backend.openHandleCount()).toBe(0);
    value.rootKey.destroy();
  });

  it("retries explicit close once without making an uncertain append reusable", async () => {
    const injector = new DeterministicPhysicalStoreFaultInjector({
      schedule: [{ occurrence: 2, operation: "closeFile", timing: "before" }],
    });
    const value = fixture({ faultInjector: injector });
    const writer = await createAuthenticatedSegmentWriter({ ...value, segmentClass: "metadata" });
    const record = encodedHizoFSRecord({
      plaintext: new Uint8Array([1]),
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    });
    await expect(writer.append({ records: [record] })).rejects.toThrow("injected");
    expect(writer.state).toBe("abandoned");
    expect(value.backend.openHandleCount()).toBe(0);
    injector.assertExhausted();
    value.rootKey.destroy();
  });

  it("permanently abandons the writer after an outcome-unknown append", async () => {
    const injector = new DeterministicPhysicalStoreFaultInjector({
      schedule: [{ occurrence: 2, operation: "writeAt", timing: "after" }],
    });
    const value = fixture({ faultInjector: injector });
    const writer = await createAuthenticatedSegmentWriter({ ...value, segmentClass: "metadata" });
    const record = encodedHizoFSRecord({
      plaintext: new Uint8Array([1]),
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    });
    await expect(writer.append({ records: [record] })).rejects.toThrow("injected");
    expect(writer.state).toBe("abandoned");
    await expect(writer.append({ records: [record] })).rejects.toThrow("abandoned");
    expect(value.backend.openHandleCount()).toBe(0);
    injector.assertExhausted();
    value.rootKey.destroy();
  });
});
