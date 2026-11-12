/** A small, source-independent staging primitive. Callers own the mutation lock,
 * resume metadata and validation. A move failure never triggers a payload copy.
 */
export type FileMoveSupport = 'supported' | 'unsupported';

type MovableFile = FileSystemFileHandle & {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Native FileSystemFileHandle.move signature.
  move?: (directory: FileSystemDirectoryHandle, name: string) => Promise<void>,
};

export function temporaryFileName({ name }: { name: string }): string {
  if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name)) {
    throw new Error('Invalid publication filename');
  }
  return `${name}.tmp`;
}

export function publicationFileName({ name, support }: { name: string, support: FileMoveSupport }): string {
  switch (support) {
  case 'supported': return temporaryFileName({ name });
  case 'unsupported': return name;
  default: {
    const exhaustive: never = support;
    throw new Error(String(exhaustive));
  }
  }
}

export async function optionalFile({ directory, name }: { directory: FileSystemDirectoryHandle, name: string }): Promise<FileSystemFileHandle | undefined> {
  try {
    return await directory.getFileHandle(name);
  } catch (error) {
    if ((error instanceof DOMException || error instanceof Error) && error.name === 'NotFoundError') {
      return undefined;
    }
    throw error;
  }
}

async function removeOwnedProbe({ directory, name, handle }: { directory: FileSystemDirectoryHandle, name: string, handle: FileSystemFileHandle }): Promise<void> {
  const current = await optionalFile({ directory, name });
  if (current && (current === handle || await current.isSameEntry(handle))) {
    await directory.removeEntry(name);
  }
}

type MoveProbeResult = { support: FileMoveSupport, cacheable: boolean };

async function probeFileMove({ directory }: { directory: FileSystemDirectoryHandle }): Promise<MoveProbeResult> {
  const token = crypto.randomUUID();
  const from = `.${token}.tmp`, to = `.${token}-m.tmp`;
  // Host files are shared with other applications. Never claim a preexisting
  // entry, even though randomly generated probe names are unlikely to collide.
  if (await optionalFile({ directory, name: from }) || await optionalFile({ directory, name: to })) {
    throw new Error('Move probe filename collision');
  }
  const handle: MovableFile = await directory.getFileHandle(from, { create: true });
  let writer: FileSystemWritableFileStream | undefined;
  try {
    if (typeof handle.move !== 'function') {
      return { support: 'unsupported', cacheable: true };
    }
    writer = await handle.createWritable();
    await writer.write(new Uint8Array([1]));
    await writer.close();
    writer = undefined;
    try {
      // The directory+name overload also works on implementations that do not
      // expose the name-only convenience overload (notably WebKit).
      await handle.move(directory, to);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotSupportedError') {
        return { support: 'unsupported', cacheable: true };
      }
      if (error instanceof DOMException && error.name === 'AbortError') {
        // Some Chromium versions report disabled non-OPFS moves as AbortError.
        // It also denotes transient failures, so choose legacy ONLY for this
        // pre-write probe and do not cache it as established non-support.
        return { support: 'unsupported', cacheable: false };
      }
      throw error;
    }
    const moved = await optionalFile({ directory, name: to });
    if (await optionalFile({ directory, name: from }) || !moved || !await moved.isSameEntry(handle) || (await moved.getFile()).size !== 1) {
      throw new Error('File move probe did not rename its file');
    }
    return { support: 'supported', cacheable: true };
  } finally {
    await writer?.abort().catch(() => undefined);
    // Only the entry we created is eligible for cleanup. Permission/storage
    // failures are observable, not permanent negative capability results.
    try {
      await removeOwnedProbe({ directory, name: from, handle });
    } finally {
      await removeOwnedProbe({ directory, name: to, handle });
    }
  }
}

export type FileMoveSupportCache = {
  detect({ directory }: { directory: FileSystemDirectoryHandle }): Promise<FileMoveSupport>,
  clear(): void,
};

/** Memory-only and caller-scoped (for example, one download Worker/session).
 * Native handles for the same directory need not have JavaScript identity.
 * Serialize lookup, not the probes, so concurrent callers share one Promise.
 */
export function createFileMoveSupportCache(): FileMoveSupportCache {
  type Entry = { directory: FileSystemDirectoryHandle, result: Promise<FileMoveSupport> };
  const entries: Entry[] = [];
  let lookup = Promise.resolve();
  return {
    async detect({ directory }) {
      const selected = lookup.then(async () => {
        for (const entry of entries) {
          if (entry.directory === directory || (typeof entry.directory.isSameEntry === 'function' && await entry.directory.isSameEntry(directory))) {
            return { entry };
          }
        }
        const entry: Entry = {
          directory,
          result: probeFileMove({ directory }).then(({ support, cacheable }) => {
            if (!cacheable) {
              const index = entries.indexOf(entry);
              if (index !== -1) {
                entries.splice(index, 1);
              }
            }
            return support;
          }),
        };
        entries.push(entry);
        // Evict operational failures; a revoked permission is not lack of move.
        void entry.result.catch(() => {
          const index = entries.indexOf(entry);
          if (index !== -1) {
            entries.splice(index, 1);
          }
        });
        return { entry };
      });
      lookup = selected.then(() => undefined, () => undefined);
      return (await selected).entry.result;
    },
    clear() {
      entries.length = 0;
    },
  };
}

/** The caller must close its writer before entering this function. Existing
 * destinations are rejected unless the caller explicitly supplies the previous
 * entry and snapshot to replace. On a host filesystem this
 * preflight is best effort: external programs need not honor Naidan's lock.
 */
export async function moveStagedFile({ directory, name, handle, snapshot, moveSupport, replacement }: {
  directory: FileSystemDirectoryHandle, name: string, handle: FileSystemFileHandle, snapshot: File, moveSupport: FileMoveSupportCache,
  replacement?: { handle: FileSystemFileHandle, snapshot: File },
}): Promise<FileSystemFileHandle> {
  const temporaryName = temporaryFileName({ name });
  const current = await directory.getFileHandle(temporaryName);
  const file = await current.getFile();
  if (!await current.isSameEntry(handle) || file.size !== snapshot.size || file.lastModified !== snapshot.lastModified) {
    throw new Error('Staged file changed before publication');
  }
  const destination = await optionalFile({ directory, name });
  if (replacement) {
    const previous = await destination?.getFile();
    if (!destination || !await destination.isSameEntry(replacement.handle) || previous?.size !== replacement.snapshot.size || previous.lastModified !== replacement.snapshot.lastModified) {
      throw new Error('Publication replacement changed; both files were preserved');
    }
  } else if (destination) {
    throw new Error('Publication destination already exists; both files were preserved');
  }
  try {
    const movable: MovableFile = handle;
    if (typeof movable.move !== 'function') {
      throw new DOMException('File move is unavailable', 'NotSupportedError');
    }
    await movable.move(directory, name);
    const published = await directory.getFileHandle(name);
    if (!await published.isSameEntry(handle) || (await published.getFile()).size !== snapshot.size || await optionalFile({ directory, name: temporaryName })) {
      throw new Error('File move did not publish the staged file');
    }
    return published;
  } catch (error) {
    moveSupport.clear();
    throw error;
  }
}

export const TEST_ONLY = {
};
