import { nanoid } from 'nanoid';
import { exactObject } from '@/utils/exact-object';
import {
  cleanupNativePlainApplicationNamespaceWithReport,
  inspectNativePlainApplicationNamespaceEntries,
  type NativePlainApplicationNamespaceObservedEntry,
} from './native-plain-application-namespace';

const MAXIMUM_EXPOSED_CONFLICT_ENTRIES = 64;

export class NativePlainTargetConflictError extends TypeError {
  public readonly code = 'native_plain_target_conflict';

  public constructor() {
    super('native plain target contains unowned application bytes');
    this.name = 'NativePlainTargetConflictError';
  }
}

export type OpfsEncryptionDisableConflictEntry = Readonly<{
  entryKind: 'directory' | 'file';
  relativePath: string;
}>;

export type OpfsEncryptionDisableConflict = Readonly<{
  entries: readonly OpfsEncryptionDisableConflictEntry[];
  inspectionId: string;
  totalEntryCount: number;
  truncated: boolean;
  type: 'conflict';
}>;

export type OpfsEncryptionDisablePreflight =
  | Readonly<{ type: 'clear' }>
  | OpfsEncryptionDisableConflict;

type ConflictSnapshot = Readonly<{
  entries: readonly NativePlainApplicationNamespaceObservedEntry[];
  inspectionId: string;
}>;

function sameEntry({ left, right }: {
  left: NativePlainApplicationNamespaceObservedEntry;
  right: NativePlainApplicationNamespaceObservedEntry;
}): boolean {
  const {
    entryKind: leftEntryKind,
    owner: leftOwner,
    path: leftPath,
    ...unhandledLeft
  } = left;
  unhandledLeft satisfies Record<PropertyKey, never>;
  const {
    entryKind: rightEntryKind,
    owner: rightOwner,
    path: rightPath,
    ...unhandledRight
  } = right;
  unhandledRight satisfies Record<PropertyKey, never>;
  return leftEntryKind === rightEntryKind
    && leftOwner === rightOwner
    && leftPath.length === rightPath.length
    && leftPath.every((segment, index) => segment === rightPath[index]);
}

function sameEntries({ left, right }: {
  left: readonly NativePlainApplicationNamespaceObservedEntry[];
  right: readonly NativePlainApplicationNamespaceObservedEntry[];
}): boolean {
  return left.length === right.length
    && left.every((entry, index) => sameEntry({ left: entry, right: right[index]! }));
}

function projectConflict({ snapshot }: {
  snapshot: ConflictSnapshot;
}): OpfsEncryptionDisableConflict {
  const exposedEntries = snapshot.entries.slice(0, MAXIMUM_EXPOSED_CONFLICT_ENTRIES).map(entry => {
    const { entryKind, owner: _owner, path, ...unhandledEntry } = entry;
    unhandledEntry satisfies Record<PropertyKey, never>;
    return exactObject<OpfsEncryptionDisableConflictEntry>()({
      entryKind,
      relativePath: path.join('/'),
    });
  });
  return exactObject<OpfsEncryptionDisableConflict>()({
    entries: exposedEntries,
    inspectionId: snapshot.inspectionId,
    totalEntryCount: snapshot.entries.length,
    truncated: exposedEntries.length !== snapshot.entries.length,
    type: 'conflict',
  });
}

export class NativePlainDisableConflictCoordinator {
  private snapshot: ConflictSnapshot | undefined;

  public async inspect({ nativeNamespaceRoot }: {
    nativeNamespaceRoot: FileSystemDirectoryHandle;
  }): Promise<OpfsEncryptionDisablePreflight> {
    const entries = await inspectNativePlainApplicationNamespaceEntries({ nativeNamespaceRoot });
    if (entries.length === 0) {
      this.snapshot = undefined;
      return { type: 'clear' };
    }
    const snapshot = {
      entries,
      inspectionId: nanoid(),
    } as const satisfies ConflictSnapshot;
    this.snapshot = snapshot;
    return projectConflict({ snapshot });
  }

  public async cleanupIfUnchanged({ inspectionId, nativeNamespaceRoot }: {
    inspectionId: string;
    nativeNamespaceRoot: FileSystemDirectoryHandle;
  }): Promise<OpfsEncryptionDisablePreflight> {
    const expected = this.snapshot;
    const actualEntries = await inspectNativePlainApplicationNamespaceEntries({ nativeNamespaceRoot });
    if (expected === undefined
      || expected.inspectionId !== inspectionId
      || !sameEntries({ left: actualEntries, right: expected.entries })) {
      return await this.inspect({ nativeNamespaceRoot });
    }

    await cleanupNativePlainApplicationNamespaceWithReport({ nativeNamespaceRoot });
    return await this.inspect({ nativeNamespaceRoot });
  }
}

export const TEST_ONLY = {
  MAXIMUM_EXPOSED_CONFLICT_ENTRIES,
  projectConflict,
  sameEntries,
};
