import { describe, expect, it } from "vitest";
import { createBlobStorageBinaryObjectReadHandle } from "@/00-storage/service/binary-object-io";
import {
  encodePersistenceControl,
  type NaidanPersistenceControlCoreV1,
  type NaidanPersistenceControlV1,
} from "@/00-storage/service/naidan-persistence-control/00-format";
import { createPlainControlProtection } from "@/00-storage/service/naidan-persistence-control/crypto";
import type { PersistenceControlProofAuthority } from "@/00-storage/service/naidan-persistence-control/store";
import { createNaidanOpfsPersistenceControlInspectionSource } from "@/00-storage/service/naidan-opfs/persistence-control-inspection-source";

async function plainControl({ copy, sequence }: { copy: 0 | 1; sequence: number }): Promise<NaidanPersistenceControlV1> {
  const core: NaidanPersistenceControlCoreV1 = {
    copy,
    format: "naidan-persistence-control",
    formatVersion: 1,
    mode: { type: "plain" },
    retiredFileSystemIds: [],
    sequence,
  };
  return { ...core, protection: await createPlainControlProtection({ core }) };
}

function proofAuthority(): PersistenceControlProofAuthority {
  return {
    resolveRootKey: async () => ({ state: "unresolved" }),
    validateEndpointReadiness: async () => "valid",
  };
}

function exactArrayBuffer({ bytes }: { bytes: Uint8Array }): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}

function file({ bytes, closeFailure, observedSize = bytes.byteLength, readableSize = bytes.byteLength }: {
  bytes: Uint8Array;
  closeFailure?: Error;
  observedSize?: number;
  readableSize?: number;
}) {
  return {
    async stat() {
      return { createdAt: undefined, modifiedAt: undefined, size: observedSize };
    },
    async openReadable() {
      const handle = createBlobStorageBinaryObjectReadHandle({ blob: new Blob([exactArrayBuffer({ bytes })]), mimeType: "application/json" });
      return {
        ...handle,
        close: async () => {
          await handle.close();
          if (closeFailure !== undefined) throw closeFailure;
        },
        size: readableSize,
      };
    },
  };
}

function root({ files }: { files: ReadonlyMap<string, ReturnType<typeof file>> }) {
  const directoryCalls: Array<{ create: boolean; name: string }> = [];
  const fileCalls: Array<{ create: boolean; name: string }> = [];
  const collection = {
    async getDirectoryHandle(): Promise<never> {
      throw new Error("nested directory access is not expected");
    },
    async getFileHandle({ create, name }: { create: boolean; name: string }) {
      fileCalls.push({ create, name });
      const value = files.get(name);
      if (value === undefined) throw new DOMException("missing", "NotFoundError");
      return value;
    },
  };
  return {
    directoryCalls,
    fileCalls,
    storageRoot: {
      async getDirectoryHandle({ create, name }: { create: boolean; name: string }) {
        directoryCalls.push({ create, name });
        if (name !== "persistence-control") throw new DOMException("missing", "NotFoundError");
        return collection;
      },
      async getFileHandle(): Promise<never> {
        throw new Error("root file access is not expected");
      },
    },
  };
}

describe("Naidan OPFS Persistence Control inspection source", () => {
  it("reads both canonical copies without creating directories or files", async () => {
    const first = encodePersistenceControl({ control: await plainControl({ copy: 0, sequence: 1 }) });
    const second = encodePersistenceControl({ control: await plainControl({ copy: 1, sequence: 2 }) });
    const fixture = root({ files: new Map([
      ["state-0.json", file({ bytes: first })],
      ["state-1.json", file({ bytes: second })],
    ]) });
    const source = createNaidanOpfsPersistenceControlInspectionSource({
      proofAuthority: proofAuthority(),
      storageRoot: fixture.storageRoot,
    });

    const inspection = await source.inspectPersistenceControl();

    expect(inspection.selection).toEqual({ copy: 1, redundancy: "converged", sequence: 2, state: "selected" });
    expect(fixture.directoryCalls).toEqual([
      { create: false, name: "persistence-control" },
      { create: false, name: "persistence-control" },
    ]);
    expect(fixture.fileCalls).toEqual([
      { create: false, name: "state-0.json" },
      { create: false, name: "state-1.json" },
    ]);
  });

  it("keeps missing copies visible instead of creating storage", async () => {
    const fixture = root({ files: new Map() });
    const source = createNaidanOpfsPersistenceControlInspectionSource({
      proofAuthority: proofAuthority(),
      storageRoot: fixture.storageRoot,
    });

    const inspection = await source.inspectPersistenceControl();

    expect(inspection.copies.map(copy => copy.state)).toEqual(["structurally_invalid", "structurally_invalid"]);
    expect(inspection.copies.map(copy => copy.reason)).toEqual(["missing", "missing"]);
    expect(fixture.fileCalls.every(call => !call.create)).toBe(true);
  });

  it("rejects an observed file larger than the bounded inspection limit", async () => {
    const fixture = root({ files: new Map([
      ["state-0.json", file({ bytes: new Uint8Array(), observedSize: 65_537 })],
    ]) });
    const source = createNaidanOpfsPersistenceControlInspectionSource({
      proofAuthority: proofAuthority(),
      storageRoot: fixture.storageRoot,
    });

    await expect(source.inspectPersistenceControl()).rejects.toThrow("bounded inspection limit");
  });

  it("preserves bounded-read and handle-close failures in order", async () => {
    const closeFailure = new Error("inspection read handle close failed");
    const fixture = root({ files: new Map([
      ["state-0.json", file({
        bytes: new Uint8Array([1]),
        closeFailure,
        observedSize: 1,
        readableSize: 2,
      })],
    ]) });
    const source = createNaidanOpfsPersistenceControlInspectionSource({
      proofAuthority: proofAuthority(),
      storageRoot: fixture.storageRoot,
    });

    await expect(source.inspectPersistenceControl()).rejects.toEqual(expect.objectContaining({
      errors: [
        expect.objectContaining({ message: "Persistence Control file size changed during bounded inspection" }),
        closeFailure,
      ],
    }));
  });

  it("rejects a file whose size changes between stat and open", async () => {
    const fixture = root({ files: new Map([
      ["state-0.json", file({ bytes: new Uint8Array([1]), observedSize: 1, readableSize: 2 })],
    ]) });
    const source = createNaidanOpfsPersistenceControlInspectionSource({
      proofAuthority: proofAuthority(),
      storageRoot: fixture.storageRoot,
    });

    await expect(source.inspectPersistenceControl()).rejects.toThrow("size changed during bounded inspection");
  });
});
