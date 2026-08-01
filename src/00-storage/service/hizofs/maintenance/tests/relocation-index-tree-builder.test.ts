import { describe, expect, it } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createPhysicalRecordReference,
  createUInt64,
  decodeRelocationIndexPage,
  parseSegmentId,
  type RelocationLeafEntry,
} from "@/00-storage/service/hizofs/00-format";
import {
  RelocationIndexTreeBuilderError,
  buildRelocationIndexTree,
} from "@/00-storage/service/hizofs/maintenance/relocation-index-tree-builder";
import { createMaintenancePolicy } from "@/00-storage/service/hizofs/maintenance/maintenance-policy";

function entry({ index }: { index: number }): RelocationLeafEntry {
  const homeSegmentId = parseSegmentId({ bytes: new Uint8Array(16).fill(Math.floor(index / 1000) + 1) });
  return {
    currentPhysicalRecordRef: createPhysicalRecordReference({ fields: {
      byteOffset: createUInt64({ value: 64n + BigInt(index * 96) }),
      frameLength: 96,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(100 + (index % 100)) }),
    } }),
    homeOffset: createUInt64({ value: 64n + BigInt((index % 1000) * 96) }),
    homeSegmentId,
  };
}

function rootReference({ index }: { index: number }) {
  return createPhysicalRecordReference({ fields: {
    byteOffset: createUInt64({ value: 64n + BigInt(index * 96) }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(220) }),
  } });
}

describe("relocation index tree builder", () => {
  it("represents an empty mapping set with a null root and no physical page", async () => {
    let appendCount = 0;
    await expect(buildRelocationIndexTree({
      appendPhysicalOnlyPage: async () => {
        appendCount += 1;
        return rootReference({ index: appendCount });
      },
      entries: [],
      policy: createMaintenancePolicy(),
    })).resolves.toEqual({ level: null, pageCount: 0, rootPhysicalReference: null });
    expect(appendCount).toBe(0);
  });

  it("writes one canonical leaf as the root", async () => {
    const pages: Uint8Array[] = [];
    const result = await buildRelocationIndexTree({
      appendPhysicalOnlyPage: async ({ plaintext }) => {
        pages.push(Uint8Array.from(plaintext));
        return rootReference({ index: pages.length });
      },
      entries: [entry({ index: 0 }), entry({ index: 1 })],
      policy: createMaintenancePolicy(),
    });
    expect(result).toMatchObject({ level: 0, pageCount: 1 });
    expect(decodeRelocationIndexPage({ bytes: pages[0] ?? new Uint8Array(), isRoot: true }))
      .toMatchObject({ level: 0, type: "leaf" });
  });

  it("builds leaves before a branch root and binds child upper bounds", async () => {
    const maximum = HIZOFS_V1_FORMAT_CONSTANTS.pageItemMaximumCounts.relocationLeaf;
    const entries = Array.from({ length: maximum + 1 }, (_, index) => entry({ index }));
    const pages: Uint8Array[] = [];
    const result = await buildRelocationIndexTree({
      appendPhysicalOnlyPage: async ({ plaintext }) => {
        pages.push(Uint8Array.from(plaintext));
        return rootReference({ index: pages.length });
      },
      entries,
      policy: createMaintenancePolicy(),
    });
    expect(result).toMatchObject({ level: 1, pageCount: 3 });
    const root = decodeRelocationIndexPage({ bytes: pages[2] ?? new Uint8Array(), isRoot: true });
    expect(root.type).toBe("branch");
    if (root.type !== "branch") throw new Error("expected branch root");
    expect(root.entries).toHaveLength(2);
    expect(root.entries[0]?.upperBound).toMatchObject({
      homeOffset: entries[maximum - 1]?.homeOffset,
      homeSegmentId: entries[maximum - 1]?.homeSegmentId,
    });
    expect(root.entries[1]?.upperBound).toMatchObject({
      homeOffset: entries[maximum]?.homeOffset,
      homeSegmentId: entries[maximum]?.homeSegmentId,
    });
  });

  it("fails closed on non-canonical input, wrong append kind, page mutation, or page budget exhaustion", async () => {
    await expect(buildRelocationIndexTree({
      appendPhysicalOnlyPage: async () => rootReference({ index: 1 }),
      entries: [entry({ index: 1 }), entry({ index: 0 })],
      policy: createMaintenancePolicy(),
    })).rejects.toThrowError(RelocationIndexTreeBuilderError);
    await expect(buildRelocationIndexTree({
      appendPhysicalOnlyPage: async () => createPhysicalRecordReference({ fields: {
        ...rootReference({ index: 1 }),
        recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
      } }),
      entries: [entry({ index: 0 })],
      policy: createMaintenancePolicy(),
    })).rejects.toThrowError(RelocationIndexTreeBuilderError);
    await expect(buildRelocationIndexTree({
      appendPhysicalOnlyPage: async ({ plaintext }) => {
        plaintext[0] = 255;
        return rootReference({ index: 1 });
      },
      entries: [entry({ index: 0 })],
      policy: createMaintenancePolicy(),
    })).rejects.toThrowError(RelocationIndexTreeBuilderError);
    const maximum = HIZOFS_V1_FORMAT_CONSTANTS.pageItemMaximumCounts.relocationLeaf;
    await expect(buildRelocationIndexTree({
      appendPhysicalOnlyPage: async () => rootReference({ index: 1 }),
      entries: Array.from({ length: maximum + 1 }, (_, index) => entry({ index })),
      policy: createMaintenancePolicy({ maxRelocationIndexPages: 2 }),
    })).rejects.toThrowError(RelocationIndexTreeBuilderError);
  });
});
