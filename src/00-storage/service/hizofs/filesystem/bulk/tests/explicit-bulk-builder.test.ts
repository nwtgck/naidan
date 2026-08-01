import { describe, expect, it, vi } from "vitest";
import {
  createInodeNumber,
  createInodeRevision,
  createTimestampMilliseconds,
} from "@/00-storage/service/hizofs/00-format";
import { ExplicitBulkBuilder } from "@/00-storage/service/hizofs/filesystem/bulk/explicit-bulk-builder";

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  reject: (reason: unknown) => void;
  resolve: (value: T) => void;
}> {
  let reject!: (reason: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done, fail) => {
    reject = fail;
    resolve = done;
  });
  return { promise, reject, resolve };
}

function builder() {
  return new ExplicitBulkBuilder({
    candidate: {
      limits: { maxEntries: 8, maxInlineFileBytesTotal: 32 },
      nextInodeNumber: createInodeNumber({ value: 10n }),
      rootDirectory: {
        inodeNumber: createInodeNumber({ value: 1n }),
        inodeRevision: createInodeRevision({ value: 1n }),
        timestamps: {
          createdAt: createTimestampMilliseconds({ value: 1n }),
          modifiedAt: createTimestampMilliseconds({ value: 1n }),
        },
      },
    },
    ownerView: "mutable_live",
    target: { empty: true, fresh: true },
  });
}

const timestamp = createTimestampMilliseconds({ value: 5n });

describe("Explicit bulk builder", () => {
  it("keeps mutations private and publishes the complete candidate exactly once", async () => {
    const value = builder();
    await value.createEmptyFile({
      name: "file",
      parentDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      timestamp,
    });
    const prepare = vi.fn(async ({ candidate }: Parameters<Parameters<typeof value.commit>[0]["prepare"]>[0]) => ({
      entryCount: candidate.directories.flatMap(directory => directory.entries).length,
    }));
    const publish = vi.fn(async ({ prepared }: { prepared: { entryCount: number } }) => prepared.entryCount);
    expect(prepare).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();

    await expect(value.commit({ prepare, publish })).resolves.toBe(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(value.state()).toBe("committed");
    await expect(value.commit({ prepare, publish })).rejects.toMatchObject({ code: "builder_committed" });
  });

  it("revokes private preparation when owner close wins before the publication gate", async () => {
    const value = builder();
    const hold = deferred<void>();
    const publish = vi.fn(async () => undefined);
    const committing = value.commit({
      prepare: async () => {
        await hold.promise;
        return "prepared";
      },
      publish,
    });
    value.ownerClose();
    hold.resolve();

    await expect(committing).rejects.toMatchObject({ code: "capability_revoked" });
    expect(publish).not.toHaveBeenCalled();
    expect(value.state()).toBe("revoked");
  });

  it("makes candidate operation failure terminal without publication", async () => {
    const value = builder();
    await value.createEmptyFile({
      name: "same",
      parentDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      timestamp,
    });
    await expect(value.createEmptyFile({
      name: "same",
      parentDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      timestamp,
    })).rejects.toMatchObject({ code: "duplicate_entry" });
    const publish = vi.fn(async () => undefined);
    await expect(value.commit({ prepare: async () => undefined, publish }))
      .rejects.toMatchObject({ code: "builder_aborted" });
    expect(publish).not.toHaveBeenCalled();
  });

  it("becomes terminal when publication fails after the final gate", async () => {
    const value = builder();
    await expect(value.commit({
      prepare: async () => "prepared",
      publish: async () => {
        throw new Error("outcome requires resolution");
      },
    })).rejects.toThrow("outcome requires resolution");
    expect(value.state()).toBe("failed");
  });

  it("supports explicit abort without invoking preparation", async () => {
    const value = builder();
    value.abort();
    const prepare = vi.fn(async () => undefined);
    await expect(value.commit({ prepare, publish: async () => undefined }))
      .rejects.toMatchObject({ code: "builder_aborted" });
    expect(prepare).not.toHaveBeenCalled();
  });
});
