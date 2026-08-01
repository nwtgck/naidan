import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  compareUnsignedBytes,
  createPhysicalRecordReference,
  encodeRelocationIndexPage,
  type PhysicalRecordReference,
  type RelocationBranchEntry,
  type RelocationKey,
  type RelocationLeafEntry,
} from "@/00-storage/service/hizofs/00-format";
import type { HizoFSMaintenancePolicy } from "@/00-storage/service/hizofs/maintenance/maintenance-policy";

export type RelocationIndexTreeBuildResult = Readonly<{
  level: number | null;
  pageCount: number;
  rootPhysicalReference: PhysicalRecordReference | null;
}>;

export type RelocationIndexTreeBuilderErrorCode =
  | "append_mutated_plaintext"
  | "invalid_append_result"
  | "non_canonical_entries"
  | "page_budget_exceeded"
  | "tree_level_exceeded";

export class RelocationIndexTreeBuilderError extends Error {
  readonly code: RelocationIndexTreeBuilderErrorCode;

  constructor({ code, message }: { code: RelocationIndexTreeBuilderErrorCode; message: string }) {
    super(message);
    this.name = "RelocationIndexTreeBuilderError";
    this.code = code;
  }
}

type BuiltNode = Readonly<{
  physicalReference: PhysicalRecordReference;
  upperBound: RelocationKey;
}>;

function compareKeys({ left, right }: { left: RelocationKey; right: RelocationKey }): number {
  const segmentOrder = compareUnsignedBytes({ left: left.homeSegmentId, right: right.homeSegmentId });
  if (segmentOrder !== 0) return segmentOrder;
  return left.homeOffset < right.homeOffset ? -1 : left.homeOffset > right.homeOffset ? 1 : 0;
}

function sameBytes({ left, right }: { left: Uint8Array; right: Uint8Array }): boolean {
  return compareUnsignedBytes({ left, right }) === 0;
}

function cloneKey({ key }: { key: RelocationKey }): RelocationKey {
  return Object.freeze({
    homeOffset: key.homeOffset,
    homeSegmentId: Uint8Array.from(key.homeSegmentId) as typeof key.homeSegmentId,
  });
}

function cloneLeafEntry({ entry }: { entry: RelocationLeafEntry }): RelocationLeafEntry {
  return Object.freeze({
    currentPhysicalRecordRef: createPhysicalRecordReference({ fields: entry.currentPhysicalRecordRef }),
    homeOffset: entry.homeOffset,
    homeSegmentId: Uint8Array.from(entry.homeSegmentId) as typeof entry.homeSegmentId,
  });
}

function chunks<T>({ items, maximum }: { items: readonly T[]; maximum: number }): readonly (readonly T[])[] {
  const output: T[][] = [];
  for (let offset = 0; offset < items.length; offset += maximum) {
    output.push(items.slice(offset, offset + maximum));
  }
  return output;
}

export async function buildRelocationIndexTree({ appendPhysicalOnlyPage, entries, policy }: {
  appendPhysicalOnlyPage: ({ isRoot, level, plaintext }: {
    isRoot: boolean;
    level: number;
    plaintext: Uint8Array;
  }) => Promise<PhysicalRecordReference>;
  entries: readonly RelocationLeafEntry[];
  policy: HizoFSMaintenancePolicy;
}): Promise<RelocationIndexTreeBuildResult> {
  if (entries.length === 0) {
    return Object.freeze({ level: null, pageCount: 0, rootPhysicalReference: null });
  }
  const detachedEntries = entries.map(entry => cloneLeafEntry({ entry }));
  for (let index = 1; index < detachedEntries.length; index += 1) {
    const previous = detachedEntries[index - 1];
    const current = detachedEntries[index];
    if (previous === undefined || current === undefined) throw new Error("relocation entry index invariant failed");
    if (compareKeys({ left: previous, right: current }) >= 0) {
      throw new RelocationIndexTreeBuilderError({
        code: "non_canonical_entries",
        message: "Relocation Index entries must be strictly ordered by canonical Home identity",
      });
    }
  }

  let pageCount = 0;
  const appendPage = async ({ isRoot, level, plaintext }: {
    isRoot: boolean;
    level: number;
    plaintext: Uint8Array;
  }): Promise<PhysicalRecordReference> => {
    if (pageCount >= policy.maxRelocationIndexPages) {
      throw new RelocationIndexTreeBuilderError({
        code: "page_budget_exceeded",
        message: "Relocation Index rebuild exceeds the explicit page-count budget",
      });
    }
    const supplied = Uint8Array.from(plaintext);
    const expected = Uint8Array.from(supplied);
    const physicalReference = await appendPhysicalOnlyPage({ isRoot, level, plaintext: supplied });
    if (!sameBytes({ left: supplied, right: expected })) {
      throw new RelocationIndexTreeBuilderError({
        code: "append_mutated_plaintext",
        message: "Relocation Index append adapter mutated the supplied canonical page plaintext",
      });
    }
    if (physicalReference.recordKind !== HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page) {
      throw new RelocationIndexTreeBuilderError({
        code: "invalid_append_result",
        message: "Relocation Index append must return a physical-only relocation page reference",
      });
    }
    pageCount += 1;
    return createPhysicalRecordReference({ fields: physicalReference });
  };

  const leafMaximum = HIZOFS_V1_FORMAT_CONSTANTS.pageItemMaximumCounts.relocationLeaf;
  const leafChunks = chunks({ items: detachedEntries, maximum: leafMaximum });
  if (leafChunks.length === 1) {
    const onlyLeaf = leafChunks[0];
    if (onlyLeaf === undefined) throw new Error("relocation leaf chunk invariant failed");
    const rootPhysicalReference = await appendPage({
      isRoot: true,
      level: 0,
      plaintext: encodeRelocationIndexPage({
        isRoot: true,
        page: { entries: onlyLeaf, level: 0, type: "leaf" },
      }),
    });
    return Object.freeze({ level: 0, pageCount, rootPhysicalReference });
  }

  let nodes: BuiltNode[] = [];
  for (const leaf of leafChunks) {
    const last = leaf.at(-1);
    if (last === undefined) throw new Error("relocation leaf must not be empty");
    const physicalReference = await appendPage({
      isRoot: false,
      level: 0,
      plaintext: encodeRelocationIndexPage({
        isRoot: false,
        page: { entries: leaf, level: 0, type: "leaf" },
      }),
    });
    nodes.push(Object.freeze({ physicalReference, upperBound: cloneKey({ key: last }) }));
  }

  const branchMaximum = HIZOFS_V1_FORMAT_CONSTANTS.pageItemMaximumCounts.relocationBranch;
  let level = 1;
  while (nodes.length > 1) {
    if (level > HIZOFS_V1_FORMAT_CONSTANTS.limits.treeLevel) {
      throw new RelocationIndexTreeBuilderError({
        code: "tree_level_exceeded",
        message: "Relocation Index rebuild exceeds the V1 tree-level bound",
      });
    }
    const nodeChunks = chunks({ items: nodes, maximum: branchMaximum });
    const nextNodes: BuiltNode[] = [];
    const rootLevel = nodeChunks.length === 1;
    for (const nodeChunk of nodeChunks) {
      const last = nodeChunk.at(-1);
      if (last === undefined) throw new Error("relocation branch must not be empty");
      const branchEntries: readonly RelocationBranchEntry[] = nodeChunk.map(node => Object.freeze({
        childPagePhysicalRef: createPhysicalRecordReference({ fields: node.physicalReference }),
        upperBound: cloneKey({ key: node.upperBound }),
      }));
      const physicalReference = await appendPage({
        isRoot: rootLevel,
        level,
        plaintext: encodeRelocationIndexPage({
          isRoot: rootLevel,
          page: { entries: branchEntries, level, type: "branch" },
        }),
      });
      nextNodes.push(Object.freeze({ physicalReference, upperBound: cloneKey({ key: last.upperBound }) }));
    }
    nodes = nextNodes;
    level += 1;
  }
  const root = nodes[0];
  if (root === undefined) throw new Error("Relocation Index root invariant failed");
  return Object.freeze({
    level: level - 1,
    pageCount,
    rootPhysicalReference: createPhysicalRecordReference({ fields: root.physicalReference }),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
