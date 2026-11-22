const remoteHandleEntries = new WeakMap<FileSystemHandle, { access: object, id: string }>();

export function registerRemoteFileSystemEntry({ handle, access, id }: {
  handle: FileSystemHandle,
  access: object,
  id: string,
}): void {
  remoteHandleEntries.set(handle, { access, id });
}

export function getRemoteFileSystemEntryId({ handle, access }: {
  handle: FileSystemHandle,
  access: object,
}): string | undefined {
  const entry = remoteHandleEntries.get(handle);
  return entry?.access === access ? entry.id : undefined;
}

/** An `isSameEntry` result cannot establish identity across remote access grants. */
export function canCompareFileSystemEntryIdentity({ first, second }: { first: FileSystemHandle, second: FileSystemHandle }): boolean {
  return remoteHandleEntries.get(first)?.access === remoteHandleEntries.get(second)?.access;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
