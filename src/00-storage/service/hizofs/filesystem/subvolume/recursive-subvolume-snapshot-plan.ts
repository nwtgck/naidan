import {
  createSubvolumeId,
  HIZOFS_V1_FORMAT_CONSTANTS,
  UINT64_MAXIMUM,
  type DirectoryLeafEntry,
  type HomeRecordReference,
  type InodeNumber,
  type NestedSubvolumeLeafEntry,
  type SubvolumeAccess,
  type SubvolumeId,
} from "@/00-storage/service/hizofs/00-format";
import { isSameContainerCoordinationKey } from "@/00-storage/service/hizofs/filesystem/container-coordination-key";
import type {
  SubvolumeSnapshotSource,
  SubvolumeSnapshotTarget,
} from "@/00-storage/service/hizofs/filesystem/subvolume/subvolume-snapshot-plan";
import {
  validateSubvolumeTopology,
  type SubvolumeTopologyMount,
} from "@/00-storage/service/hizofs/filesystem/subvolume/subvolume-topology";

export type RecursiveSubvolumeSnapshotPlanErrorCode =
  | "allocator_exhausted"
  | "allocator_regression"
  | "cross_device"
  | "destination_exists"
  | "duplicate_rewritten_inode_table_root"
  | "duplicate_subvolume_identity"
  | "invalid_rewritten_inode_table_root"
  | "invalid_topology_limit"
  | "missing_rewritten_inode_table_root"
  | "parent_read_only"
  | "source_not_mounted"
  | "topology_cycle"
  | "topology_limit_exceeded"
  | "unexpected_rewritten_inode_table_root";

export class RecursiveSubvolumeSnapshotPlanError extends Error {
  readonly code: RecursiveSubvolumeSnapshotPlanErrorCode;

  constructor({ code, message }: { code: RecursiveSubvolumeSnapshotPlanErrorCode; message: string }) {
    super(message);
    this.name = "RecursiveSubvolumeSnapshotPlanError";
    this.code = code;
  }
}

export type RecursiveSnapshotMountEntryRewrite = Readonly<{
  entryName: string;
  parentDirectoryInodeNumber: InodeNumber;
  snapshotChildSubvolumeId: SubvolumeId;
  sourceChildSubvolumeId: SubvolumeId;
}>;

export type RecursiveSnapshotInodeTableRootPlan = Readonly<
  | {
    inodeTableRootHomeRef: HomeRecordReference;
    type: "share";
  }
  | {
    rewrites: readonly RecursiveSnapshotMountEntryRewrite[];
    sourceInodeTableRootHomeRef: HomeRecordReference;
    type: "rewrite_mount_entries";
  }
>;

export type RecursiveSubvolumeSnapshotRowDraft = Readonly<{
  access: SubvolumeAccess;
  entryName: string;
  inodeTableRootPlan: RecursiveSnapshotInodeTableRootPlan;
  parentDirectoryInodeNumber: InodeNumber;
  parentSubvolumeId: SubvolumeId;
  rootDirectoryInodeNumber: InodeNumber;
  subvolumeId: SubvolumeId;
}>;

export type RecursiveSubvolumeSnapshotPlan = Readonly<{
  directoryEntry: Extract<DirectoryLeafEntry, { targetType: "subvolume" }>;
  nextSubvolumeId: SubvolumeId;
  snapshotRowDrafts: readonly RecursiveSubvolumeSnapshotRowDraft[];
  sourceToSnapshotSubvolumeIds: readonly Readonly<{
    snapshotSubvolumeId: SubvolumeId;
    sourceSubvolumeId: SubvolumeId;
  }>[];
}>;

type SourceGraphNode = Readonly<{
  entry: Pick<
    NestedSubvolumeLeafEntry,
    "inodeTableRootHomeRef" | "rootDirectoryInodeNumber" | "subvolumeId"
  >;
  parentSourceSubvolumeId: SubvolumeId | null;
  sourceMount: NestedSubvolumeLeafEntry | null;
}>;

function referencesAreEqual({ left, right }: {
  left: HomeRecordReference;
  right: HomeRecordReference;
}): boolean {
  if (left.recordKind !== right.recordKind
    || left.byteOffset !== right.byteOffset
    || left.frameLength !== right.frameLength) return false;
  if (left.segmentId.byteLength !== right.segmentId.byteLength) return false;
  for (let index = 0; index < left.segmentId.byteLength; index += 1) {
    if (left.segmentId[index] !== right.segmentId[index]) return false;
  }
  return true;
}

function sourceMatchesRow({ row, source }: {
  row: NestedSubvolumeLeafEntry;
  source: SubvolumeSnapshotSource;
}): boolean {
  return row.access === source.access
    && row.rootDirectoryInodeNumber === source.rootDirectoryInodeNumber
    && row.subvolumeId === source.subvolumeId
    && referencesAreEqual({ left: row.inodeTableRootHomeRef, right: source.inodeTableRootHomeRef });
}

export function prepareRecursiveSubvolumeSnapshotPlan({
  maxTopologyEntries,
  nextSubvolumeId,
  rootSubvolumeId,
  sourceRoot,
  sourceTopologyMounts,
  sourceTopologyRows,
  target,
}: Readonly<{
  maxTopologyEntries: number;
  nextSubvolumeId: SubvolumeId;
  rootSubvolumeId: SubvolumeId;
  sourceRoot: SubvolumeSnapshotSource;
  sourceTopologyMounts: readonly SubvolumeTopologyMount[];
  sourceTopologyRows: readonly NestedSubvolumeLeafEntry[];
  target: SubvolumeSnapshotTarget;
}>): RecursiveSubvolumeSnapshotPlan {
  switch (sourceRoot.access) {
  case "read":
  case "read_write": break;
  default: sourceRoot.access satisfies never;
  }
  switch (target.requestedAccess) {
  case "read":
  case "read_write": break;
  default: target.requestedAccess satisfies never;
  }
  switch (target.parentAccess) {
  case "read_write": break;
  case "read": throw new RecursiveSubvolumeSnapshotPlanError({
    code: "parent_read_only",
    message: "Recursive Subvolume snapshot requires a read-write destination parent",
  });
  default: target.parentAccess satisfies never;
  }
  if (!isSameContainerCoordinationKey({
    left: sourceRoot.containerCoordinationKey,
    right: target.containerCoordinationKey,
  })) {
    throw new RecursiveSubvolumeSnapshotPlanError({
      code: "cross_device",
      message: "Recursive Subvolume snapshot must remain within one physical container",
    });
  }
  if (target.destinationExists) {
    throw new RecursiveSubvolumeSnapshotPlanError({
      code: "destination_exists",
      message: "Recursive Subvolume snapshot destination already exists",
    });
  }

  const topology = validateSubvolumeTopology({
    maxTopologyEntries,
    mounts: sourceTopologyMounts,
    rootSubvolumeId,
    rows: sourceTopologyRows,
  });
  if (sourceRoot.subvolumeId !== rootSubvolumeId) {
    const authoritativeSource = topology.rowFor({ subvolumeId: sourceRoot.subvolumeId });
    if (authoritativeSource === undefined || !sourceMatchesRow({ row: authoritativeSource, source: sourceRoot })) {
      throw new RecursiveSubvolumeSnapshotPlanError({
        code: "source_not_mounted",
        message: "Recursive snapshot source does not match the captured Nested Subvolume topology",
      });
    }
  }

  let greatestKnownSubvolumeId = sourceRoot.subvolumeId > target.parentSubvolumeId
    ? sourceRoot.subvolumeId
    : target.parentSubvolumeId;
  for (const entry of topology.rows) {
    if (entry.subvolumeId > greatestKnownSubvolumeId) greatestKnownSubvolumeId = entry.subvolumeId;
  }
  if (nextSubvolumeId <= greatestKnownSubvolumeId) {
    throw new RecursiveSubvolumeSnapshotPlanError({
      code: "allocator_regression",
      message: "Recursive snapshot allocator high-water mark does not exceed known Subvolume IDs",
    });
  }

  const sourceNodes: SourceGraphNode[] = [];
  const visiting = new Set<SubvolumeId>();
  const visited = new Set<SubvolumeId>();
  const stack: Array<Readonly<SourceGraphNode & { phase: "enter" | "exit" }>> = [{
    entry: sourceRoot,
    parentSourceSubvolumeId: null,
    phase: "enter",
    sourceMount: null,
  }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) throw new Error("Recursive snapshot traversal stack became inconsistent");
    switch (frame.phase) {
    case "exit": {
      visiting.delete(frame.entry.subvolumeId);
      visited.add(frame.entry.subvolumeId);
      continue;
    }
    case "enter": break;
    default: frame.phase satisfies never;
    }
    if (visiting.has(frame.entry.subvolumeId)) {
      throw new RecursiveSubvolumeSnapshotPlanError({
        code: "topology_cycle",
        message: "Recursive snapshot source topology contains a reachable cycle",
      });
    }
    if (visited.has(frame.entry.subvolumeId)) continue;
    visiting.add(frame.entry.subvolumeId);
    sourceNodes.push({
      entry: frame.entry,
      parentSourceSubvolumeId: frame.parentSourceSubvolumeId,
      sourceMount: frame.sourceMount,
    });
    stack.push({ ...frame, phase: "exit" });
    const children = topology.childrenOf({ parentSubvolumeId: frame.entry.subvolumeId });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child === undefined) throw new Error("Recursive snapshot child index became inconsistent");
      stack.push({
        entry: child,
        parentSourceSubvolumeId: frame.entry.subvolumeId,
        phase: "enter",
        sourceMount: child,
      });
    }
  }

  const allocationEndExclusive = nextSubvolumeId + BigInt(sourceNodes.length);
  if (allocationEndExclusive > UINT64_MAXIMUM) {
    throw new RecursiveSubvolumeSnapshotPlanError({
      code: "allocator_exhausted",
      message: "Subvolume ID allocator cannot reserve the complete recursive snapshot graph",
    });
  }

  const sourceToSnapshotId = new Map<SubvolumeId, SubvolumeId>();
  const sourceToSnapshotSubvolumeIds = sourceNodes.map((node, index) => {
    const snapshotSubvolumeId = createSubvolumeId({ value: nextSubvolumeId + BigInt(index) });
    sourceToSnapshotId.set(node.entry.subvolumeId, snapshotSubvolumeId);
    return { snapshotSubvolumeId, sourceSubvolumeId: node.entry.subvolumeId } as const;
  });

  const snapshotRowDrafts = sourceNodes.map((node, index): RecursiveSubvolumeSnapshotRowDraft => {
    const snapshotSubvolumeId = sourceToSnapshotSubvolumeIds[index]?.snapshotSubvolumeId;
    if (snapshotSubvolumeId === undefined) {
      throw new Error("Recursive snapshot ID allocation did not cover every source node");
    }
    const parentFields = node.sourceMount === null
      ? {
        entryName: target.entryName,
        parentDirectoryInodeNumber: target.parentDirectoryInodeNumber,
        parentSubvolumeId: target.parentSubvolumeId,
      }
      : (() => {
        const parentSourceSubvolumeId = node.parentSourceSubvolumeId;
        const snapshotParentSubvolumeId = parentSourceSubvolumeId === null
          ? undefined
          : sourceToSnapshotId.get(parentSourceSubvolumeId);
        if (snapshotParentSubvolumeId === undefined) {
          throw new Error("Recursive snapshot parent identity was not allocated before its child");
        }
        return {
          entryName: node.sourceMount.entryName,
          parentDirectoryInodeNumber: node.sourceMount.parentDirectoryInodeNumber,
          parentSubvolumeId: snapshotParentSubvolumeId,
        };
      })();

    const childMounts = topology.childrenOf({ parentSubvolumeId: node.entry.subvolumeId });
    const rewrites = childMounts.map((child): RecursiveSnapshotMountEntryRewrite => {
      const snapshotChildSubvolumeId = sourceToSnapshotId.get(child.subvolumeId);
      if (snapshotChildSubvolumeId === undefined) {
        throw new Error("Recursive snapshot child identity was not allocated");
      }
      return {
        entryName: child.entryName,
        parentDirectoryInodeNumber: child.parentDirectoryInodeNumber,
        snapshotChildSubvolumeId,
        sourceChildSubvolumeId: child.subvolumeId,
      };
    });
    const inodeTableRootPlan: RecursiveSnapshotInodeTableRootPlan = rewrites.length === 0
      ? { inodeTableRootHomeRef: node.entry.inodeTableRootHomeRef, type: "share" }
      : {
        rewrites,
        sourceInodeTableRootHomeRef: node.entry.inodeTableRootHomeRef,
        type: "rewrite_mount_entries",
      };
    return {
      access: target.requestedAccess,
      ...parentFields,
      inodeTableRootPlan,
      rootDirectoryInodeNumber: node.entry.rootDirectoryInodeNumber,
      subvolumeId: snapshotSubvolumeId,
    };
  });

  const snapshotRootSubvolumeId = sourceToSnapshotSubvolumeIds[0]?.snapshotSubvolumeId;
  if (snapshotRootSubvolumeId === undefined) {
    throw new Error("Recursive snapshot source graph did not contain its root");
  }
  return {
    directoryEntry: { name: target.entryName, subvolumeId: snapshotRootSubvolumeId, targetType: "subvolume" },
    nextSubvolumeId: createSubvolumeId({ value: allocationEndExclusive }),
    snapshotRowDrafts,
    sourceToSnapshotSubvolumeIds,
  };
}

export function finalizeRecursiveSubvolumeSnapshotRows({ plan, rewrittenInodeTableRoots }: {
  plan: RecursiveSubvolumeSnapshotPlan;
  rewrittenInodeTableRoots: readonly Readonly<{
    inodeTableRootHomeRef: HomeRecordReference;
    snapshotSubvolumeId: SubvolumeId;
  }>[];
}): readonly NestedSubvolumeLeafEntry[] {
  const draftsById = new Map(plan.snapshotRowDrafts.map(draft => [draft.subvolumeId, draft]));
  const rewrittenById = new Map<SubvolumeId, HomeRecordReference>();
  for (const rewritten of rewrittenInodeTableRoots) {
    if (rewrittenById.has(rewritten.snapshotSubvolumeId)) {
      throw new RecursiveSubvolumeSnapshotPlanError({
        code: "duplicate_rewritten_inode_table_root",
        message: "Recursive snapshot received duplicate rewritten Inode Table roots",
      });
    }
    const draft = draftsById.get(rewritten.snapshotSubvolumeId);
    if (draft === undefined || draft.inodeTableRootPlan.type === "share") {
      throw new RecursiveSubvolumeSnapshotPlanError({
        code: "unexpected_rewritten_inode_table_root",
        message: "Recursive snapshot received an unexpected rewritten Inode Table root",
      });
    }
    if (rewritten.inodeTableRootHomeRef.recordKind !== HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page) {
      throw new RecursiveSubvolumeSnapshotPlanError({
        code: "invalid_rewritten_inode_table_root",
        message: "Recursive snapshot rewritten root must reference an Inode Table page",
      });
    }
    rewrittenById.set(rewritten.snapshotSubvolumeId, rewritten.inodeTableRootHomeRef);
  }

  return plan.snapshotRowDrafts.map((draft): NestedSubvolumeLeafEntry => {
    const inodeTableRootHomeRef = (() => {
      switch (draft.inodeTableRootPlan.type) {
      case "share": return draft.inodeTableRootPlan.inodeTableRootHomeRef;
      case "rewrite_mount_entries": {
        const rewritten = rewrittenById.get(draft.subvolumeId);
        if (rewritten === undefined) {
          throw new RecursiveSubvolumeSnapshotPlanError({
            code: "missing_rewritten_inode_table_root",
            message: "Recursive snapshot is missing a required rewritten Inode Table root",
          });
        }
        return rewritten;
      }
      default: return draft.inodeTableRootPlan satisfies never;
      }
    })();
    return {
      access: draft.access,
      entryName: draft.entryName,
      inodeTableRootHomeRef,
      parentDirectoryInodeNumber: draft.parentDirectoryInodeNumber,
      parentSubvolumeId: draft.parentSubvolumeId,
      rootDirectoryInodeNumber: draft.rootDirectoryInodeNumber,
      subvolumeId: draft.subvolumeId,
    };
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
