import {
  HizoFSSubvolumeMountIndexPageSchemaDto,
  type HizoFSSubvolumeMountDto,
  type HizoFSSubvolumeMountIndexPageDto,
} from '@/00-storage/00-dto/hizofs.dto';
import { validateHizoFSStableId } from '@/00-storage/service/hizofs/id';
import {
  PersistentHizoFSIndex,
  type PersistentIndexPage,
  type PersistentIndexPageStore,
} from './persistent-index';
import { compareHizoFSStrings } from './ordering';
import { assertHizoFSObjectId } from './semantic-validation';
import type { HizoFSRecordStore } from './record-store';
import type { HizoFSRuntimeDiagnostics } from './diagnostics';

class SubvolumeMountIndexPageStore implements PersistentIndexPageStore<
  string,
  HizoFSSubvolumeMountDto
> {
  constructor({ recordStore }: { recordStore: HizoFSRecordStore }) {
    this.recordStore = recordStore;
  }

  private readonly recordStore: HizoFSRecordStore;

  async readPage({ objectId }: {
    objectId: string;
  }): Promise<PersistentIndexPage<string, HizoFSSubvolumeMountDto>> {
    const { metadata } = await this.recordStore.read({
      objectId,
      expectedKind: 'subvolume_mount_index_page',
      schema: HizoFSSubvolumeMountIndexPageSchemaDto,
      binaryPayload: 'forbidden',
    });
    assertPage({ page: metadata });
    switch (metadata.type) {
    case 'leaf':
      return { type: 'leaf', entries: metadata.mounts };
    case 'branch':
      return {
        type: 'branch',
        children: metadata.children.map(child => ({
          upperBound: child.upperBoundMountId,
          childPageObjectId: child.childPageObjectId,
        })),
      };
    default: {
      const _ex: never = metadata;
      throw new Error(`Unhandled HizoFS subvolume mount page: ${String(_ex)}`);
    }
    }
  }

  async writePage({ page }: {
    page: PersistentIndexPage<string, HizoFSSubvolumeMountDto>;
  }): Promise<string> {
    const metadata: HizoFSSubvolumeMountIndexPageDto = (() => {
      switch (page.type) {
      case 'leaf':
        return { type: 'leaf', mounts: page.entries };
      case 'branch':
        return {
          type: 'branch',
          children: page.children.map(child => ({
            upperBoundMountId: child.upperBound,
            childPageObjectId: child.childPageObjectId,
          })),
        };
      default: {
        const _ex: never = page;
        throw new Error(`Unhandled HizoFS subvolume mount page: ${String(_ex)}`);
      }
      }
    })();
    assertPage({ page: metadata });
    return this.recordStore.write({
      kind: 'subvolume_mount_index_page',
      metadata,
      binaryPayload: new Uint8Array(),
    });
  }
}

function assertMount({ mount }: { mount: HizoFSSubvolumeMountDto }): void {
  validateHizoFSStableId({
    value: mount.mountId,
    fieldName: 'HizoFS subvolume mount ID',
  });
  assertHizoFSObjectId({
    value: mount.subvolumeDescriptorObjectId,
    fieldName: 'HizoFS subvolume descriptor ObjectRef',
  });
  validateHizoFSStableId({
    value: mount.parentDirectoryNodeId,
    fieldName: 'HizoFS subvolume mount parent directory node ID',
  });
  if (mount.entryName.length === 0) {
    throw new Error('HizoFS subvolume mount entry name must not be empty');
  }
}

function assertPage({ page }: { page: HizoFSSubvolumeMountIndexPageDto }): void {
  switch (page.type) {
  case 'leaf': {
    let previousMountId: string | undefined;
    for (const mount of page.mounts) {
      assertMount({ mount });
      if (
        previousMountId !== undefined
        && compareHizoFSStrings({ left: previousMountId, right: mount.mountId }) >= 0
      ) {
        throw new Error('HizoFS subvolume mounts must be strictly sorted');
      }
      previousMountId = mount.mountId;
    }
    break;
  }
  case 'branch': {
    if (page.children.length === 0) {
      throw new Error('HizoFS subvolume mount branch must contain a child');
    }
    let previousUpperBound: string | undefined;
    for (const child of page.children) {
      validateHizoFSStableId({
        value: child.upperBoundMountId,
        fieldName: 'HizoFS subvolume mount upper bound',
      });
      assertHizoFSObjectId({
        value: child.childPageObjectId,
        fieldName: 'HizoFS subvolume mount child page ObjectRef',
      });
      if (
        previousUpperBound !== undefined
        && compareHizoFSStrings({ left: previousUpperBound, right: child.upperBoundMountId }) >= 0
      ) {
        throw new Error('HizoFS subvolume mount branch bounds must be strictly sorted');
      }
      previousUpperBound = child.upperBoundMountId;
    }
    break;
  }
  default: {
    const _ex: never = page;
    throw new Error(`Unhandled HizoFS subvolume mount page: ${String(_ex)}`);
  }
  }
}

export class HizoFSSubvolumeMountIndex {
  constructor({ recordStore, maxPageEntries, diagnostics }: {
    recordStore: HizoFSRecordStore;
    maxPageEntries: number;
    diagnostics: HizoFSRuntimeDiagnostics | undefined;
  }) {
    this.pageStore = new SubvolumeMountIndexPageStore({ recordStore });
    this.index = new PersistentHizoFSIndex({
      pageStore: this.pageStore,
      compare: compareHizoFSStrings,
      getEntryKey: ({ entry }) => entry.mountId,
      maxPageEntries,
    });
    this.diagnostics = diagnostics;
  }

  private readonly pageStore: SubvolumeMountIndexPageStore;
  private readonly index: PersistentHizoFSIndex<string, HizoFSSubvolumeMountDto>;
  private readonly diagnostics: HizoFSRuntimeDiagnostics | undefined;

  createEmpty(): Promise<string> {
    return this.measure({ phase: 'index_build', operation: async () => this.index.createEmpty() });
  }

  get({ rootObjectId, mountId }: {
    rootObjectId: string;
    mountId: string;
  }): Promise<HizoFSSubvolumeMountDto | undefined> {
    return this.index.get({ rootObjectId, key: mountId });
  }

  set({ rootObjectId, mount }: {
    rootObjectId: string;
    mount: HizoFSSubvolumeMountDto;
  }): Promise<string> {
    assertMount({ mount });
    return this.measure({
      phase: 'index_update',
      operation: async () => this.index.set({ rootObjectId, entry: mount }),
    });
  }

  delete({ rootObjectId, mountId }: {
    rootObjectId: string;
    mountId: string;
  }): Promise<string> {
    return this.measure({
      phase: 'index_update',
      operation: async () => this.index.delete({ rootObjectId, key: mountId }),
    });
  }

  entries({ rootObjectId }: {
    rootObjectId: string;
  }): AsyncIterable<HizoFSSubvolumeMountDto> {
    return this.index.entries({ rootObjectId });
  }

  buildFromSortedEntries({ mounts }: {
    mounts: readonly HizoFSSubvolumeMountDto[];
  }): Promise<string> {
    for (const mount of mounts) assertMount({ mount });
    return this.measure({
      phase: 'index_build',
      operation: async () => this.index.buildFromSortedEntries({ entries: mounts }),
    });
  }

  validateStructure({ rootObjectId }: {
    rootObjectId: string;
  }): Promise<{
    readonly pageCount: number;
    readonly entryCount: number;
    readonly depth: number;
  }> {
    return this.index.validateStructure({ rootObjectId });
  }

  async visitReferences({
    rootObjectId,
    visitPageObjectId,
    visitDescriptorObjectId,
    visitedPageObjectIds,
  }: {
    rootObjectId: string;
    visitPageObjectId: ({ objectId }: { objectId: string }) => void;
    visitDescriptorObjectId: ({ objectId }: { objectId: string }) => void;
    visitedPageObjectIds: Set<string> | undefined;
  }): Promise<void> {
    const completed = visitedPageObjectIds ?? new Set<string>();
    const visiting = new Set<string>();
    const seenInThisTraversal = new Set<string>();
    const visitPage = async ({ objectId }: { objectId: string }): Promise<void> => {
      visitPageObjectId({ objectId });
      if (visiting.has(objectId)) {
        throw new Error('HizoFS subvolume mount index contains a page cycle');
      }
      if (seenInThisTraversal.has(objectId)) {
        throw new Error(
          'HizoFS subvolume mount index contains a duplicate page reference',
        );
      }
      seenInThisTraversal.add(objectId);
      if (completed.has(objectId)) return;
      visiting.add(objectId);
      try {
        const page = await this.pageStore.readPage({ objectId });
        switch (page.type) {
        case 'leaf':
          for (const mount of page.entries) {
            visitDescriptorObjectId({ objectId: mount.subvolumeDescriptorObjectId });
          }
          break;
        case 'branch':
          for (const child of page.children) {
            await visitPage({ objectId: child.childPageObjectId });
          }
          break;
        default: {
          const _ex: never = page;
          throw new Error(`Unhandled HizoFS subvolume mount page: ${String(_ex)}`);
        }
        }
      } finally {
        visiting.delete(objectId);
      }
      completed.add(objectId);
    };
    await visitPage({ objectId: rootObjectId });
  }

  private measure<T>({ phase, operation }: {
    phase: 'index_build' | 'index_update';
    operation: () => Promise<T>;
  }): Promise<T> {
    return this.diagnostics === undefined
      ? operation()
      : this.diagnostics.measureAsync({ phase, operation });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
