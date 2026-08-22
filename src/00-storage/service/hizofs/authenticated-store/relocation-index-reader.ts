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
import type { FileSystemRootKey } from "@/00-storage/service/hizofs/01-crypto";
import type { HizoFSReadableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import { authenticatedStoreError } from "./errors";
import {
  measureAuthenticatedCodecOperation,
  type AuthenticatedStoreDiagnosticsPort,
} from "@/00-storage/service/hizofs/authenticated-store/diagnostics-hooks";
import {
  physicalReferenceAtHome,
  readAuthenticatedPhysicalRecord,
  type AuthenticatedRecordRead,
} from "./record-reader";

export type AuthenticatedRelocationPageReader = ({ isRoot, physicalReference }: Readonly<{
  isRoot: boolean;
  physicalReference: PhysicalRecordReference;
}>) => Promise<RelocationIndexPage>;

export type AuthenticatedRelocationPageRecordCachePolicy = Readonly<{
  maximumBytes: number;
  maximumEntries: number;
}>;

type AuthenticatedRelocationPageRecordCacheEntry = Readonly<{
  plaintext: Uint8Array;
}>;

function validateRelocationPageCacheBound({ name, value }: { name: string; value: number }): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

/**
 * Retains authenticated physical-only Relocation Index page plaintext for one
 * application session. Cache identity includes the exact immutable Relocation
 * Index root plus the page reference and root-role bit, so a later authority
 * cannot reuse a page under a different tree root.
 *
 * Returned plaintext is caller-owned. Retained plaintext stays private and is
 * zeroized on eviction/disposal. Pending loads are bounded by the same policy.
 */
export class AuthenticatedRelocationPageRecordCache {
  private currentBytes = 0;
  private disposed = false;
  private readonly entries = new Map<string, AuthenticatedRelocationPageRecordCacheEntry>();
  private pendingLoadFrameBytes = 0;
  private readonly pendingLoads = new Map<string, Promise<void>>();
  private readonly policy: AuthenticatedRelocationPageRecordCachePolicy;

  constructor({ policy }: { policy: AuthenticatedRelocationPageRecordCachePolicy }) {
    validateRelocationPageCacheBound({ name: "Relocation page cache maximum bytes", value: policy.maximumBytes });
    validateRelocationPageCacheBound({ name: "Relocation page cache maximum entries", value: policy.maximumEntries });
    this.policy = Object.freeze({ ...policy });
  }

  clear(): void {
    for (const entry of this.entries.values()) entry.plaintext.fill(0);
    this.entries.clear();
    this.currentBytes = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
  }

  discard({ identity }: { identity: string }): void {
    const entry = this.entries.get(identity);
    if (entry === undefined) return;
    this.entries.delete(identity);
    this.currentBytes -= entry.plaintext.byteLength;
    entry.plaintext.fill(0);
  }

  async read({ frameLength, identity, load }: {
    frameLength: number;
    identity: string;
    load: () => Promise<Uint8Array>;
  }): Promise<Uint8Array> {
    if (this.disposed) throw new TypeError("authenticated Relocation page cache is disposed");
    validateRelocationPageCacheBound({ name: "Relocation page cache frame length", value: frameLength });

    const cached = this.entries.get(identity);
    if (cached !== undefined) {
      this.promote({ identity, entry: cached });
      return cached.plaintext.slice();
    }

    const sharedLoad = this.pendingLoads.get(identity);
    if (sharedLoad !== undefined) {
      await sharedLoad;
      if (this.disposed) throw new TypeError("authenticated Relocation page cache is disposed");
      const coalesced = this.entries.get(identity);
      if (coalesced !== undefined) {
        this.promote({ identity, entry: coalesced });
        return coalesced.plaintext.slice();
      }
      return await this.read({ frameLength, identity, load });
    }

    const canSingleFlight = this.policy.maximumBytes > 0
      && this.policy.maximumEntries > 0
      && frameLength <= this.policy.maximumBytes
      && this.pendingLoadFrameBytes + frameLength <= this.policy.maximumBytes
      && this.pendingLoads.size < this.policy.maximumEntries;
    if (canSingleFlight) {
      const pending = this.loadAndRetain({ identity, load });
      this.pendingLoads.set(identity, pending);
      this.pendingLoadFrameBytes += frameLength;
      try {
        await pending;
      } finally {
        if (this.pendingLoads.get(identity) === pending) {
          this.pendingLoads.delete(identity);
          this.pendingLoadFrameBytes -= frameLength;
        }
      }
      if (this.disposed) throw new TypeError("authenticated Relocation page cache is disposed");
      const admitted = this.entries.get(identity);
      if (admitted !== undefined) {
        this.promote({ identity, entry: admitted });
        return admitted.plaintext.slice();
      }
      return await this.read({ frameLength, identity, load });
    }

    const plaintext = await load();
    if (this.disposed) {
      plaintext.fill(0);
      throw new TypeError("authenticated Relocation page cache was disposed while loading a page");
    }
    const concurrentlyCached = this.entries.get(identity);
    if (concurrentlyCached !== undefined) {
      plaintext.fill(0);
      this.promote({ identity, entry: concurrentlyCached });
      return concurrentlyCached.plaintext.slice();
    }
    if (!this.canRetain({ plaintextBytes: plaintext.byteLength })) return plaintext;
    this.admitOwnedPlaintext({ identity, plaintext });
    return plaintext.slice();
  }

  private async loadAndRetain({ identity, load }: {
    identity: string;
    load: () => Promise<Uint8Array>;
  }): Promise<void> {
    const plaintext = await load();
    if (this.disposed) {
      plaintext.fill(0);
      throw new TypeError("authenticated Relocation page cache was disposed while loading a page");
    }
    const concurrentlyCached = this.entries.get(identity);
    if (concurrentlyCached !== undefined) {
      plaintext.fill(0);
      this.promote({ identity, entry: concurrentlyCached });
      return;
    }
    if (!this.canRetain({ plaintextBytes: plaintext.byteLength })) {
      plaintext.fill(0);
      return;
    }
    this.admitOwnedPlaintext({ identity, plaintext });
  }

  private canRetain({ plaintextBytes }: { plaintextBytes: number }): boolean {
    return this.policy.maximumBytes > 0
      && this.policy.maximumEntries > 0
      && plaintextBytes <= this.policy.maximumBytes;
  }

  private admitOwnedPlaintext({ identity, plaintext }: { identity: string; plaintext: Uint8Array }): void {
    while (
      this.entries.size >= this.policy.maximumEntries
      || this.currentBytes + plaintext.byteLength > this.policy.maximumBytes
    ) {
      const oldest = this.entries.entries().next().value as [string, AuthenticatedRelocationPageRecordCacheEntry] | undefined;
      if (oldest === undefined) break;
      const [oldestIdentity, oldestEntry] = oldest;
      this.entries.delete(oldestIdentity);
      this.currentBytes -= oldestEntry.plaintext.byteLength;
      oldestEntry.plaintext.fill(0);
    }
    this.entries.set(identity, { plaintext });
    this.currentBytes += plaintext.byteLength;
  }

  private promote({ identity, entry }: { identity: string; entry: AuthenticatedRelocationPageRecordCacheEntry }): void {
    this.entries.delete(identity);
    this.entries.set(identity, entry);
  }
}

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

function relocationPageCacheIdentity({ isRoot, physicalReference, rootPhysicalReference }: {
  isRoot: boolean;
  physicalReference: PhysicalRecordReference;
  rootPhysicalReference: PhysicalRecordReference;
}): string {
  return `${physicalReferenceIdentity({ reference: rootPhysicalReference })}|${isRoot ? "root" : "non_root"}|${physicalReferenceIdentity({ reference: physicalReference })}`;
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

type RelocationSubtreeBounds = Readonly<{
  maximum: RelocationKey;
  minimum: RelocationKey;
}>;

export async function validateRelocationIndexTree({ readPage, rootPhysicalReference }: {
  readPage: AuthenticatedRelocationPageReader;
  rootPhysicalReference: PhysicalRecordReference;
}): Promise<void> {
  if (rootPhysicalReference.recordKind !== HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page) {
    throw authenticatedStoreError({
      code: "control_plane_corrupt",
      message: "Relocation Index root has the wrong record kind",
    });
  }
  const visited = new Set<string>();

  const visit = async ({ depth, expectedLevel, isRoot, physicalReference }: {
    depth: number;
    expectedLevel: number | undefined;
    isRoot: boolean;
    physicalReference: PhysicalRecordReference;
  }): Promise<RelocationSubtreeBounds | undefined> => {
    if (depth > HIZOFS_V1_FORMAT_CONSTANTS.limits.treeLevel) {
      throw authenticatedStoreError({
        code: "control_plane_corrupt",
        message: "Relocation Index exceeds the V1 depth bound",
      });
    }
    const identity = physicalReferenceIdentity({ reference: physicalReference });
    if (visited.has(identity)) {
      throw authenticatedStoreError({
        code: "control_plane_corrupt",
        message: "Relocation Index contains a cycle or duplicate page reference",
      });
    }
    visited.add(identity);

    const page = await readPage({ isRoot, physicalReference });
    if (expectedLevel !== undefined && page.level !== expectedLevel) {
      throw authenticatedStoreError({
        code: "control_plane_corrupt",
        message: "Relocation Index child level does not match its parent",
      });
    }
    switch (page.type) {
    case "leaf": {
      const first = page.entries[0];
      const last = page.entries.at(-1);
      if (first === undefined || last === undefined) {
        if (isRoot) return undefined;
        throw authenticatedStoreError({
          code: "control_plane_corrupt",
          message: "Relocation Index non-root leaf must not be empty",
        });
      }
      return { maximum: last, minimum: first };
    }
    case "branch": {
      if (page.level < 1 || page.entries.length === 0) {
        throw authenticatedStoreError({
          code: "control_plane_corrupt",
          message: "Relocation Index branch level or entry count is invalid",
        });
      }
      let minimum: RelocationKey | undefined;
      let previousMaximum: RelocationKey | undefined;
      for (const entry of page.entries) {
        if (entry.childPagePhysicalRef.recordKind !== HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page) {
          throw authenticatedStoreError({
            code: "control_plane_corrupt",
            message: "Relocation Index child has the wrong record kind",
          });
        }
        const childBounds = await visit({
          depth: depth + 1,
          expectedLevel: page.level - 1,
          isRoot: false,
          physicalReference: entry.childPagePhysicalRef,
        });
        if (childBounds === undefined) {
          throw authenticatedStoreError({
            code: "control_plane_corrupt",
            message: "Relocation Index branch references an empty child",
          });
        }
        if (compareRelocationKeys({ left: childBounds.maximum, right: entry.upperBound }) !== 0) {
          throw authenticatedStoreError({
            code: "control_plane_corrupt",
            message: "Relocation Index branch upper bound does not match its child",
          });
        }
        if (previousMaximum !== undefined
          && compareRelocationKeys({ left: childBounds.minimum, right: previousMaximum }) <= 0) {
          throw authenticatedStoreError({
            code: "control_plane_corrupt",
            message: "Relocation Index contains overlapping sibling ranges",
          });
        }
        minimum ??= childBounds.minimum;
        previousMaximum = childBounds.maximum;
      }
      if (minimum === undefined || previousMaximum === undefined) {
        throw new Error("Relocation Index branch validation invariant failed");
      }
      return { maximum: previousMaximum, minimum };
    }
    default:
      return page satisfies never;
    }
  };

  await visit({
    depth: 0,
    expectedLevel: undefined,
    isRoot: true,
    physicalReference: rootPhysicalReference,
  });
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
  pageRecordCache,
  physicalReference,
  rootKey,
  rootPhysicalReference,
}: {
  backend: HizoFSReadableBackend;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  isRoot: boolean;
  pageRecordCache?: AuthenticatedRelocationPageRecordCache;
  physicalReference: PhysicalRecordReference;
  rootKey: FileSystemRootKey;
  rootPhysicalReference: PhysicalRecordReference;
}): Promise<RelocationIndexPage> {
  const loadPlaintext = async (): Promise<Uint8Array> => {
    const record = await readAuthenticatedPhysicalRecord({
      backend,
      diagnostics,
      expectedIdentity: { type: "physical_only" },
      fileSystemId,
      physicalReference,
      rootKey,
    });
    return record.plaintext;
  };
  const cacheIdentity = relocationPageCacheIdentity({ isRoot, physicalReference, rootPhysicalReference });
  const plaintext = pageRecordCache === undefined
    ? await loadPlaintext()
    : await pageRecordCache.read({
      frameLength: physicalReference.frameLength,
      identity: cacheIdentity,
      load: loadPlaintext,
    });
  try {
    return measureAuthenticatedCodecOperation({
      diagnostics,
      format: "record",
      operation: "decode",
      run: () => decodeRelocationIndexPage({ bytes: plaintext, isRoot }),
    });
  } catch (cause: unknown) {
    pageRecordCache?.discard({ identity: cacheIdentity });
    throw authenticatedStoreError({
      cause,
      code: "control_plane_corrupt",
      message: "Relocation Index page decode failed",
    });
  } finally {
    plaintext.fill(0);
  }
}

export async function validateAuthenticatedRelocationIndexTree({
  backend,
  diagnostics,
  fileSystemId,
  rootKey,
  rootPhysicalReference,
}: {
  backend: HizoFSReadableBackend;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  rootKey: FileSystemRootKey;
  rootPhysicalReference: PhysicalRecordReference;
}): Promise<void> {
  await validateRelocationIndexTree({
    readPage: async ({ isRoot, physicalReference }) => await readAuthenticatedRelocationPage({
      backend,
      diagnostics,
      fileSystemId,
      isRoot,
      physicalReference,
      rootKey,
      rootPhysicalReference,
    }),
    rootPhysicalReference,
  });
}

export async function resolveAuthenticatedHomeRecord({
  backend,
  diagnostics,
  fileSystemId,
  homeReference,
  relocationIndexRootPhysicalRef,
  relocationPageRecordCache,
  rootKey,
}: {
  backend: HizoFSReadableBackend;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  homeReference: HomeRecordReference;
  relocationIndexRootPhysicalRef: PhysicalRecordReference | null;
  relocationPageRecordCache?: AuthenticatedRelocationPageRecordCache;
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
        pageRecordCache: relocationPageRecordCache,
        physicalReference,
        rootKey,
        rootPhysicalReference: relocationIndexRootPhysicalRef,
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
