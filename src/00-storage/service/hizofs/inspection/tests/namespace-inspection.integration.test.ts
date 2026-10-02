import { describe, expect, it } from "vitest";
import { HIZOFS_V1_FORMAT_CONSTANTS, createFeatureBits } from "@/00-storage/service/hizofs/00-format";
import { createEmptyEncryptedContainer } from "@/00-storage/service/hizofs/authenticated-store/empty-container-store";
import { createAuthenticatedHizoFSInspectionPort } from "@/00-storage/service/hizofs/authenticated-store/inspection-port";
import type { AuthenticatedHizoFSPhysicalBytes } from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import type { RandomByteSource } from "@/00-storage/service/hizofs/01-crypto";
import { inspectHizoFSNamespacePath } from "@/00-storage/service/hizofs/inspection";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";
import { createWritableScenarioSession } from "@/00-storage/service/hizofs/v1-format-tests/support/hizofs-test-environment";

const passphrase = "correct horse battery staple";

function deterministicRandomSource(): RandomByteSource {
  let next = 1;
  return ({ bytes }) => {
    for (let index = 0; index < bytes.byteLength; index += 1) {
      bytes[index] = next;
      next = next === 251 ? 1 : next + 1;
    }
  };
}

async function physical() {
  const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
  const opened = await createEmptyEncryptedContainer({
    backend,
    passphrase,
    randomSource: deterministicRandomSource(),
    supportedFeatureBits: createFeatureBits({ value: 0n }),
  });
  opened.rootKey.destroy();
  return createAuthenticatedHizoFSInspectionPort({ backend });
}

describe("HizoFS namespace inspection", () => {
  it("resolves the active root through authenticated Home References", async () => {
    const inspection = await inspectHizoFSNamespacePath({
      maximumDirectoryEntries: 8,
      maximumPages: 8,
      passphrase,
      pathComponents: [],
      physical: await physical(),
    });
    expect(inspection).toMatchObject({
      authorityMode: "active",
      commitSequence: "1",
      directory: { entries: [], truncated: false },
      inode: {
        fileSize: undefined,
        inodeKind: "directory",
        inodeNumber: "1",
        inodeRevision: "1",
        symlinkTarget: undefined,
      },
      pathComponents: [],
    });
    expect(inspection.pagesRead).toBeGreaterThan(0);
    expect(inspection.pageReads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        request: expect.objectContaining({ pageIsRoot: true }),
        role: "inode_table",
      }),
    ]));
    expect(inspection.pageReadsTruncated).toBe(false);
    expect(inspection.selectedInodeEvidence).toMatchObject({
      containingInodeTablePage: {
        pageIsRoot: true,
        recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      },
      entry: {
        content: { entries: [], type: "inline" },
        inodeKind: "directory",
        inodeNumber: 1n,
        inodeRevision: 1n,
      },
    });
    const serializedInspection = JSON.stringify(inspection, (_key, value: unknown) => (
      typeof value === "bigint" ? value.toString() : value
    ));
    expect(serializedInspection).not.toContain("passphrase");
    expect(serializedInspection).not.toContain("rootKey");
  });

  it("fails closed when complete inode validation exceeds the page budget", async () => {
    await expect(inspectHizoFSNamespacePath({
      maximumDirectoryEntries: 8,
      maximumPages: 1,
      passphrase,
      pathComponents: [],
      physical: await physical(),
    })).rejects.toMatchObject({ code: "page_budget_exceeded" });
  });

  it("does not expose namespace data for an invalid credential", async () => {
    await expect(inspectHizoFSNamespacePath({
      passphrase: "wrong passphrase",
      pathComponents: [],
      physical: await physical(),
    })).rejects.toBeDefined();
  });

  it("does not resurrect a deleted path from the preceding Commit", async () => {
    const { backend, passphrase, session } = await createWritableScenarioSession();
    try {
      await session.root.getFileHandle({ create: true, name: "removed.txt" });
      await session.sync();
      await session.root.removeEntry({ name: "removed.txt", recursive: false });
      await session.sync();
      const physical = createAuthenticatedHizoFSInspectionPort({ backend });

      await expect(inspectHizoFSNamespacePath({ passphrase, pathComponents: [], physical })).resolves.toMatchObject({
        authorityMode: "active",
        commitSequence: "3",
        directory: { entries: [] },
      });
      await expect(inspectHizoFSNamespacePath({ passphrase, pathComponents: ["removed.txt"], physical }))
        .rejects.toMatchObject({ code: "not_found" });
    } finally {
      await session.close();
    }
  });
});
