import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  decodeRelocationIndexPage,
  segmentIdToLowercaseHex,
  type FileSystemId,
  type HomeRecordReference,
  type PhysicalRecordReference,
  type RelocationIndexPage,
  type RelocationKey,
} from "@/00-storage/service/hizofs/00-format";
import type { FileSystemRootKey } from "@/00-storage/service/hizofs/crypto";
import type { HizoFSReadableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import { authenticatedStoreError } from "./errors";
import {
  measureAuthenticatedCodecOperation,
  type AuthenticatedStoreDiagnosticsPort,
} from "./runtime-diagnostics-port";
import {
  physicalReferenceAtHome,
  readAuthenticatedPhysicalRecord,
  type AuthenticatedRecordRead,
} from "./record-reader";

export type AuthenticatedRelocationPageReader = ({ isRoot, physicalReference }: Readonly<{
  isRoot: boolean;
  physicalReference: PhysicalRecordReference;
}>) => Promise<RelocationIndexPage>;

function compareUnsignedBytes({ left, right }: { left: Uint8Array; right: Uint8Array }): number {
  for (let index = 0; index < left.byteLength; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

function compareRelocationKeys({ left, right }: { left: RelocationKey; right: RelocationKey }): number {
  const segmentOrder = compareUnsignedBytes({ left: left.homeSegmentId, right: right.homeSegmentId });
  if (segmentOrder !== 0) return segmentOrder;
  if (left.homeOffset < right.homeOffset) return -1;
  if (left.homeOffset > right.homeOffset) return 1;
  return 0;
}

function lastPageKey({ page }: { page: RelocationIndexPage }): RelocationKey {
  switch (page.type) {
  case "leaf": {
    const last = page.entries.at(-1);
    if (last === undefined) {
      throw authenticatedStoreError({
        code: "control_plane_corrupt",
        message: "Relocation Index leaf must not be empty",
      });
    }
    return last;
  }
  case "branch": {
    const last = page.entries.at(-1);
    if (last === undefined) {
      throw authenticatedStoreError({
        code: "control_plane_corrupt",
        message: "Relocation Index branch must not be empty",
      });
    }
    return last.upperBound;
  }
  }
}

function physicalReferenceIdentity({ reference }: { reference: PhysicalRecordReference }): string {
  return `${segmentIdToLowercaseHex({ id: reference.segmentId })}:${reference.byteOffset.toString()}:${reference.frameLength}`;
}

function validateMappedReference({ homeReference, mappedReference }: {
  homeReference: HomeRecordReference;
  mappedReference: PhysicalRecordReference;
}): void {
  if (mappedReference.recordKind !== homeReference.recordKind
    || mappedReference.frameLength !== homeReference.frameLength) {
    throw authenticatedStoreError({
      code: "control_plane_corrupt",
      message: "Relocation mapping changes the logical record kind or frame length",
    });
  }
}

function findLeafEntry({ key, page }: {
  key: RelocationKey;
  page: Extract<RelocationIndexPage, { type: "leaf" }>;
}) {
  let lower = 0;
  let upper = page.entries.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    const candidate = page.entries[middle];
    if (candidate === undefined) throw new Error("Relocation Index binary-search invariant failed");
    const comparison = compareRelocationKeys({ left: candidate, right: key });
    if (comparison < 0) lower = middle + 1;
    else upper = middle;
  }
  const candidate = page.entries[lower];
  return candidate !== undefined && compareRelocationKeys({ left: candidate, right: key }) === 0
    ? candidate
    : undefined;
}

function findBranchChild({ key, page }: {
  key: RelocationKey;
  page: Extract<RelocationIndexPage, { type: "branch" }>;
}) {
  let lower = 0;
  let upper = page.entries.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    const candidate = page.entries[middle];
    if (candidate === undefined) throw new Error("Relocation Index binary-search invariant failed");
    if (compareRelocationKeys({ left: candidate.upperBound, right: key }) < 0) lower = middle + 1;
    else upper = middle;
  }
  return page.entries[lower];
}

export async function lookupRelocationMapping({ homeReference, readPage, rootPhysicalReference }: {
  homeReference: HomeRecordReference;
  readPage: AuthenticatedRelocationPageReader;
  rootPhysicalReference: PhysicalRecordReference;
}): Promise<PhysicalRecordReference | null> {
  if (rootPhysicalReference.recordKind !== HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page) {
    throw authenticatedStoreError({
      code: "control_plane_corrupt",
      message: "Relocation Index root has the wrong record kind",
    });
  }
  const key: RelocationKey = {
    homeOffset: homeReference.byteOffset,
    homeSegmentId: homeReference.segmentId,
  };
  const visited = new Set<string>();
  let physicalReference = rootPhysicalReference;
  let isRoot = true;
  let expectedLevel: number | undefined;
  let expectedUpperBound: RelocationKey | undefined;

  for (let depth = 0; depth <= HIZOFS_V1_FORMAT_CONSTANTS.limits.treeLevel; depth += 1) {
    const identity = physicalReferenceIdentity({ reference: physicalReference });
    if (visited.has(identity)) {
      throw authenticatedStoreError({ code: "control_plane_corrupt", message: "Relocation Index contains a cycle" });
    }
    visited.add(identity);
    const page = await readPage({ isRoot, physicalReference });
    if (expectedLevel !== undefined && page.level !== expectedLevel) {
      throw authenticatedStoreError({
        code: "control_plane_corrupt",
        message: "Relocation Index child level does not match its parent",
      });
    }
    const pageMaximum = lastPageKey({ page });
    if (expectedUpperBound !== undefined
      && compareRelocationKeys({ left: pageMaximum, right: expectedUpperBound }) !== 0) {
      throw authenticatedStoreError({
        code: "control_plane_corrupt",
        message: "Relocation Index branch upper bound does not match its child",
      });
    }
    switch (page.type) {
    case "leaf": {
      const entry = findLeafEntry({ key, page });
      if (entry === undefined) return null;
      validateMappedReference({ homeReference, mappedReference: entry.currentPhysicalRecordRef });
      return entry.currentPhysicalRecordRef;
    }
    case "branch": {
      if (page.level < 1) {
        throw authenticatedStoreError({ code: "control_plane_corrupt", message: "Relocation Index branch level is invalid" });
      }
      const selected = findBranchChild({ key, page });
      if (selected === undefined) return null;
      if (selected.childPagePhysicalRef.recordKind !== HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page) {
        throw authenticatedStoreError({ code: "control_plane_corrupt", message: "Relocation Index child has the wrong record kind" });
      }
      physicalReference = selected.childPagePhysicalRef;
      expectedLevel = page.level - 1;
      expectedUpperBound = selected.upperBound;
      isRoot = false;
      break;
    }
    default:
      return page satisfies never;
    }
  }
  throw authenticatedStoreError({
    code: "control_plane_corrupt",
    message: "Relocation Index exceeds the V1 depth bound",
  });
}

async function readAuthenticatedRelocationPage({
  backend,
  diagnostics,
  fileSystemId,
  isRoot,
  physicalReference,
  rootKey,
}: {
  backend: HizoFSReadableBackend;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  isRoot: boolean;
  physicalReference: PhysicalRecordReference;
  rootKey: FileSystemRootKey;
}): Promise<RelocationIndexPage> {
  const record = await readAuthenticatedPhysicalRecord({
    backend,
    diagnostics,
    expectedIdentity: { type: "physical_only" },
    fileSystemId,
    physicalReference,
    rootKey,
  });
  try {
    return measureAuthenticatedCodecOperation({
      diagnostics,
      format: "record",
      operation: "decode",
      run: () => decodeRelocationIndexPage({ bytes: record.plaintext, isRoot }),
    });
  } catch (cause: unknown) {
    throw authenticatedStoreError({
      cause,
      code: "control_plane_corrupt",
      message: "Relocation Index page decode failed",
    });
  }
}

export async function resolveAuthenticatedHomeRecord({
  backend,
  diagnostics,
  fileSystemId,
  homeReference,
  relocationIndexRootPhysicalRef,
  rootKey,
}: {
  backend: HizoFSReadableBackend;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  homeReference: HomeRecordReference;
  relocationIndexRootPhysicalRef: PhysicalRecordReference | null;
  rootKey: FileSystemRootKey;
}): Promise<AuthenticatedRecordRead> {
  const mappedReference = relocationIndexRootPhysicalRef === null
    ? null
    : await lookupRelocationMapping({
      homeReference,
      readPage: async ({ isRoot, physicalReference }) => await readAuthenticatedRelocationPage({
        backend,
        diagnostics,
        fileSystemId,
        isRoot,
        physicalReference,
        rootKey,
      }),
      rootPhysicalReference: relocationIndexRootPhysicalRef,
    });
  return await readAuthenticatedPhysicalRecord({
    backend,
    diagnostics,
    expectedIdentity: { homeReference, type: "logical" },
    fileSystemId,
    physicalReference: mappedReference ?? physicalReferenceAtHome({ homeReference }),
    rootKey,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
