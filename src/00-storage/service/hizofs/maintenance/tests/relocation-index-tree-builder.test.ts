import { describe, expect, it } from "vitest";
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createPhysicalRecordReference,
  createUInt64,
  decodeRelocationIndexPage,
  encodeRelocationIndexPage,
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
  const leafMaximum = HIZOFS_V1_FORMAT_CONSTANTS.pageItemMaximumCounts.relocationLeaf;

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

  it.each([
    { entryCount: leafMaximum + 1, maxPages: 2 },
    { entryCount: 2 * leafMaximum + 1, maxPages: 3 },
  ])("rejects $entryCount entries with a $maxPages-page budget before appending", async ({ entryCount, maxPages }) => {
    let appendCount = 0;
    await expect(buildRelocationIndexTree({
      appendPhysicalOnlyPage: async () => rootReference({ index: ++appendCount }),
      entries: Array.from({ length: entryCount }, (_, index) => entry({ index })),
      policy: createMaintenancePolicy({ maxRelocationIndexPages: maxPages }),
    })).rejects.toMatchObject({
      code: "page_budget_exceeded",
      name: "RelocationIndexTreeBuilderError",
    });
    expect(appendCount).toBe(0);
  });

  it.each([
    { entryCount: 0, level: null, pageCount: 0 },
    { entryCount: 1, level: 0, pageCount: 1 },
    { entryCount: leafMaximum, level: 0, pageCount: 1 },
    { entryCount: leafMaximum + 1, level: 1, pageCount: 3 },
    { entryCount: 2 * leafMaximum + 1, level: 1, pageCount: 4 },
  ])("preserves exact packing for $entryCount entries at its $pageCount-page boundary", async ({ entryCount, level, pageCount }) => {
    const entries = Array.from({ length: entryCount }, (_, index) => entry({ index }));
    const pages: { isRoot: boolean; level: number; plaintext: Uint8Array }[] = [];
    const result = await buildRelocationIndexTree({
      appendPhysicalOnlyPage: async page => {
        pages.push(page);
        return rootReference({ index: pages.length });
      },
      entries,
      policy: createMaintenancePolicy({ maxRelocationIndexPages: Math.max(1, pageCount) }),
    });
    expect(result).toEqual({
      level,
      pageCount,
      rootPhysicalReference: pageCount === 0 ? null : rootReference({ index: pageCount }),
    });
    const expectedPages: typeof pages = [];
    for (let offset = 0; offset < entries.length; offset += leafMaximum) {
      const isRoot = pageCount === 1;
      expectedPages.push({
        isRoot,
        level: 0,
        plaintext: encodeRelocationIndexPage({
          isRoot,
          page: { entries: entries.slice(offset, offset + leafMaximum), level: 0, type: "leaf" },
        }),
      });
    }
    if (pageCount > 1) {
      const branches = expectedPages.map((_, index) => {
        const upperBound = entries[Math.min((index + 1) * leafMaximum, entries.length) - 1];
        if (upperBound === undefined) throw new Error("expected a leaf upper bound");
        return {
          childPagePhysicalRef: rootReference({ index: index + 1 }),
          upperBound: { homeOffset: upperBound.homeOffset, homeSegmentId: upperBound.homeSegmentId },
        };
      });
      expectedPages.push({
        isRoot: true,
        level: 1,
        plaintext: encodeRelocationIndexPage({ isRoot: true, page: { entries: branches, level: 1, type: "branch" } }),
      });
    }
    expect(pages).toEqual(expectedPages);
  });

  it.each(["descending", "duplicate"] as const)("keeps %s input rejection ahead of an insufficient page budget", async order => {
    const entries = Array.from({ length: leafMaximum + 1 }, (_, index) => entry({ index }));
    if (order === "descending") entries.reverse();
    else entries[1] = entry({ index: 0 });
    let appendCount = 0;
    await expect(buildRelocationIndexTree({
      appendPhysicalOnlyPage: async () => rootReference({ index: ++appendCount }),
      entries,
      policy: createMaintenancePolicy({ maxRelocationIndexPages: 1 }),
    })).rejects.toMatchObject({ code: "non_canonical_entries" });
    expect(appendCount).toBe(0);
  });

  it("validates cloned physical references before an insufficient page budget", async () => {
    const entries = Array.from({ length: leafMaximum + 1 }, (_, index) => entry({ index }));
    const invalid = entry({ index: 0 });
    entries[0] = {
      ...invalid,
      currentPhysicalRecordRef: { ...invalid.currentPhysicalRecordRef, frameLength: 0 },
    };
    let appendCount = 0;
    await expect(buildRelocationIndexTree({
      appendPhysicalOnlyPage: async () => rootReference({ index: ++appendCount }),
      entries,
      policy: createMaintenancePolicy({ maxRelocationIndexPages: 1 }),
    })).rejects.toThrowError(RangeError);
    expect(appendCount).toBe(0);
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
