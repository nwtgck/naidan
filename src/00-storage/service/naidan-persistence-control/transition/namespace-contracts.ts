import {
  comparePortableFilenameComponentBytes,
  encodePortableFilenameComponent,
  encodePortableSymlinkTarget,
} from '@/00-storage/service/hizofs/compatibility';
import type { TransitionNamespaceEntry } from '@/00-storage/service/naidan-persistence-control/transition/namespace-copy';

export class TransitionNamespaceContractError extends Error {
  public constructor({ code, message }: {
    code: 'invalid_directory_page' | 'invalid_entry_name' | 'invalid_symlink_target';
    message: string;
  }) {
    super(message);
    this.code = code;
    this.name = 'TransitionNamespaceContractError';
  }

  public readonly code: 'invalid_directory_page' | 'invalid_entry_name' | 'invalid_symlink_target';
}

export function validateTransitionNamespaceEntryName({ name }: { name: string }): Uint8Array {
  try {
    return encodePortableFilenameComponent({ value: name });
  } catch (cause: unknown) {
    throw new TransitionNamespaceContractError({
      code: 'invalid_entry_name',
      message: `namespace entry name is not a portable canonical filename component: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
}

/** Compares already encoded entry names in the transition's canonical order. */
export function compareTransitionNamespaceEntryNameBytes({ left, right }: {
  left: Uint8Array;
  right: Uint8Array;
}): number {
  return comparePortableFilenameComponentBytes({ left, right });
}

export function validateTransitionNamespaceDirectoryPage({ afterName, entries, maximumEntries, state }: {
  afterName: string | undefined;
  entries: readonly TransitionNamespaceEntry[];
  maximumEntries: number;
  state: 'complete' | 'more';
}): void {
  if (entries.length > maximumEntries || (state === 'more' && entries.length === 0)) {
    throw new TransitionNamespaceContractError({ code: 'invalid_directory_page', message: 'namespace source returned an invalid bounded directory page' });
  }
  let previous = afterName === undefined ? undefined : validateTransitionNamespaceEntryName({ name: afterName });
  for (const entry of entries) {
    const nameBytes = validateTransitionNamespaceEntryName({ name: entry.name });
    if (previous !== undefined && compareTransitionNamespaceEntryNameBytes({ left: previous, right: nameBytes }) >= 0) {
      throw new TransitionNamespaceContractError({ code: 'invalid_directory_page', message: 'namespace directory page is not strict canonical ascending order' });
    }
    previous = nameBytes;
  }
}

export function validateTransitionSymlinkTarget({ target }: { target: string }): void {
  try {
    encodePortableSymlinkTarget({ value: target });
  } catch (cause: unknown) {
    throw new TransitionNamespaceContractError({
      code: 'invalid_symlink_target',
      message: `symbolic link target is not portable HizoFS V1 data: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
}

export const TEST_ONLY = {
};
