const _extensionsByVolume = new Map<string, Set<string>>();
const _controllers = new Map<string, AbortController>();
const _scanPromises = new Map<string, Promise<void>>();

function getExtension({ filename }: { filename: string }): string | undefined {
  const dot = filename.lastIndexOf('.');
  if (dot === -1 || dot === filename.length - 1) return undefined;
  return filename.slice(dot).toLowerCase();
}

async function _doScan({
  volumeId,
  handle,
  maxFiles,
  maxDepth,
  signal,
}: {
  volumeId: string;
  handle: FileSystemDirectoryHandle;
  maxFiles: number;
  maxDepth: number;
  signal: AbortSignal;
}): Promise<void> {
  const extensions = _extensionsByVolume.get(volumeId) ?? new Set<string>();
  _extensionsByVolume.set(volumeId, extensions);

  let fileCount = 0;
  const queue: Array<{ dir: FileSystemDirectoryHandle; depth: number }> = [
    { dir: handle, depth: 0 },
  ];

  while (queue.length > 0 && fileCount < maxFiles && !signal.aborted) {
    const item = queue.shift()!;
    try {
      for await (const [name, entry] of item.dir.entries()) {
        if (signal.aborted || fileCount >= maxFiles) break;
        switch (entry.kind) {
        case 'file': {
          const ext = getExtension({ filename: name });
          if (ext) extensions.add(ext);
          fileCount++;
          break;
        }
        case 'directory': {
          if (item.depth < maxDepth) {
            queue.push({ dir: entry as FileSystemDirectoryHandle, depth: item.depth + 1 });
          }
          break;
        }
        default: {
          const _ex: never = entry.kind;
          throw new Error(`Unhandled entry kind: ${_ex}`);
        }
        }
      }
    } catch {
      // inaccessible directory — skip
    }
  }
}

export function startVolumeExtensionScan({
  volumeId,
  handle,
}: {
  volumeId: string;
  handle: FileSystemDirectoryHandle;
}): void {
  _controllers.get(volumeId)?.abort();
  const controller = new AbortController();
  _controllers.set(volumeId, controller);
  const promise = _doScan({ volumeId, handle, maxFiles: 300, maxDepth: 4, signal: controller.signal });
  _scanPromises.set(volumeId, promise);
  void promise;
}

export function abortOngoingScans(): void {
  for (const controller of _controllers.values()) {
    controller.abort();
  }
  _controllers.clear();
}

export function getVolumeExtensions({ volumeId }: { volumeId: string }): Set<string> {
  return _extensionsByVolume.get(volumeId) ?? new Set();
}

export function isVolumeScanned({ volumeId }: { volumeId: string }): boolean {
  return _extensionsByVolume.has(volumeId);
}

export const __testOnly = {
  reset() {
    abortOngoingScans();
    _extensionsByVolume.clear();
    _scanPromises.clear();
  },
  scanPromises: _scanPromises,
};
