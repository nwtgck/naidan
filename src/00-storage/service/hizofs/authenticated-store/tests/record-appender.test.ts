import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseFileSystemId,
} from "@/00-storage/service/hizofs/00-format";
import { generateFileSystemRootKey, type RandomByteSource } from "@/00-storage/service/hizofs/01-crypto";
import { DeterministicPhysicalStoreFaultInjector } from "@/00-storage/service/hizofs/physical-store/testing/deterministic-fault-injector";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";
import { describe, expect, it } from "vitest";
import type { AuthenticatedHizoFSPhysicalBytes } from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import {
  readAuthenticatedHomeRecord,
  readAuthenticatedPhysicalRecord,
} from "@/00-storage/service/hizofs/authenticated-store/record-reader";
import { createAuthenticatedSegmentWriter, encodedHizoFSRecord } from "@/00-storage/service/hizofs/authenticated-store/record-appender";
import type {
  AuthenticatedCryptoDiagnosticsObservation,
  AuthenticatedRecordDiagnosticsObservation,
} from "@/00-storage/service/hizofs/authenticated-store/diagnostics-hooks";


class FileSizeBlockingBackend extends InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes> {
  #blockNextFileSize = false;
  readonly #fileSizeStarted: Promise<void>;
  #fileSizeStartedResolve: (() => void) | undefined;
  readonly #releaseFileSize: Promise<void>;
  #releaseFileSizeResolve: (() => void) | undefined;

  public constructor() {
    super({});
    this.#fileSizeStarted = new Promise(resolve => {
      this.#fileSizeStartedResolve = resolve;
    });
    this.#releaseFileSize = new Promise(resolve => {
      this.#releaseFileSizeResolve = resolve;
    });
  }

  public blockNextFileSize(): void {
    this.#blockNextFileSize = true;
  }
  public async waitForFileSize(): Promise<void> {
    await this.#fileSizeStarted;
  }
  public releaseFileSize(): void {
    this.#releaseFileSizeResolve?.();
  }

  public override async getFileSize(
    input: Parameters<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["getFileSize"]>[0],
  ): Promise<bigint | undefined> {
    if (this.#blockNextFileSize) {
      this.#blockNextFileSize = false;
      this.#fileSizeStartedResolve?.();
      await this.#releaseFileSize;
    }
    return await super.getFileSize(input);
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

  public override async createFileExclusive(
    input: Parameters<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["createFileExclusive"]>[0],
  ): ReturnType<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["createFileExclusive"]> {
    this.events.push(`create:${input.path}`);
    return await super.createFileExclusive(input);
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
  #blockNextDurability = false;
  readonly #durabilityStarted: Promise<void>;
  #durabilityStartedResolve: (() => void) | undefined;
  readonly #releaseDurability: Promise<void>;
  #releaseDurabilityResolve: (() => void) | undefined;

  public constructor() {
    super({});
    this.#durabilityStarted = new Promise(resolve => {
      this.#durabilityStartedResolve = resolve;
    });
    this.#releaseDurability = new Promise(resolve => {
      this.#releaseDurabilityResolve = resolve;
    });
  }

  public blockNextDurability(): void {
    this.#blockNextDurability = true;
  }

  public async waitForDurability(): Promise<void> {
    await this.#durabilityStarted;
  }

  public releaseDurability(): void {
    this.#releaseDurabilityResolve?.();
  }

  public override async syncFileData(
    input: Parameters<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["syncFileData"]>[0],
  ): Promise<void> {
    if (this.#blockNextDurability) {
      this.#blockNextDurability = false;
      this.#durabilityStartedResolve?.();
      await this.#releaseDurability;
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
    await expect(writer.seal()).resolves.toMatchObject({ state: "sealed" });
    expect(writer.state).toBe("sealed");
    await expect(writer.append({ records: [
      encodedHizoFSRecord({ plaintext: new Uint8Array(), recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit }),
    ] })).rejects.toThrow("sealed");
    expect(value.backend.openHandleCount()).toBe(0);
    value.rootKey.destroy();
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
