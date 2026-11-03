import { storageService } from '@/00-storage/service';
import { createRemoteDirectoryHandle } from '@/utils/remote-directory-handle';
import { idToRaw, type VolumeId } from '@/01-models/ids';
import type { WorkflowRuntimeServices, WorkflowRunResult } from './runtime';
import { readOutput, textChunks, serializeValue, safeRelativePath, type RuntimeValue } from './values';
import { createFileExplorerDirectoryArchive } from '@/features/file-explorer/worker/directory-archive';

export async function resolveWorkflowFolder({ volumeId, mode }: { volumeId: VolumeId, mode: 'read' | 'write' }): Promise<{ directory: FileSystemDirectoryHandle, close: () => Promise<void> }> {
  const access = await storageService.resolveVolumeAccess({ volumeId });
  switch (access.kind) {
  case 'native': return { directory: access.handle, close: async () => undefined };
  case 'managed': {
    const connection = await storageService.createManagedVolumeAccess({ reference: access.reference, readOnly: mode === 'read' });
    return { directory: createRemoteDirectoryHandle({ access: connection.access, root: connection.root }), close: () => connection.dispose() };
  }
  case 'incomplete': throw new Error('This folder is still being imported.');
  case 'missing': throw new Error('The selected folder is unavailable.');
  default: {
    const exhaustive: never = access;
    throw new Error(`Unknown folder access: ${exhaustive}`);
  }
  }
}

async function parentDirectory({ directory, path, create }: { directory: FileSystemDirectoryHandle, path: string[], create: boolean }): Promise<{ directory: FileSystemDirectoryHandle, name: string }> {
  safeRelativePath({ path: path.join('/') });
  let parent = directory;
  for (const segment of path.slice(0, -1)) {
    parent = await parent.getDirectoryHandle(segment, { create });
  }
  return { directory: parent, name: path.at(-1)! };
}

export async function* workflowFileChunks({ source, format, signal }: { source: RuntimeValue, format: 'text' | 'json' | 'jsonl' | 'binary', signal: AbortSignal }): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  async function* encoded({ chunks }: { chunks: AsyncIterable<string> }): AsyncGenerator<Uint8Array> {
    for await (const text of chunks) {
      for (let offset = 0; offset < text.length;) {
        signal.throwIfAborted();
        let end = Math.min(text.length, offset + 8192);
        const last = text.charCodeAt(end - 1);
        if (end < text.length && last >= 0xd800 && last <= 0xdbff) {
          end--;
        }
        yield encoder.encode(text.slice(offset, end));
        offset = end;
      }
    }
  }
  switch (format) {
  case 'binary':
    switch (source.type) {
    case 'binary': yield* readOutput({ output: source.output, signal });
      return;
    case 'text': case 'json': case 'model': case 'sequence': case 'array': case 'object': case 'conversation': throw new Error('Binary output requires a binary value.');
    default: {
      const exhaustive: never = source;
      throw new Error(`Unknown value: ${exhaustive}`);
    }
    }
  case 'text': yield* encoded({ chunks: textChunks({ value: source, signal }) });
    return;
  case 'json': yield* encoded({ chunks: serializeValue({ value: source, signal }) });
    return;
  case 'jsonl': {
    switch (source.type) {
    case 'sequence': yield* readOutput({ output: source.output, signal });
      return;
    case 'array':
      for (const value of source.items) {
        yield* encoded({ chunks: serializeValue({ value, signal }) });
        yield encoder.encode('\n');
      }
      return;
    case 'json':
      if (!Array.isArray(source.value)) {
        throw new Error('JSON Lines output requires an array.');
      }
      for (const value of source.value) {
        yield* encoded({ chunks: serializeValue({ value: { type: 'json', value }, signal }) });
        yield encoder.encode('\n');
      }
      return;
    case 'text': case 'binary': case 'model': case 'object': case 'conversation': throw new Error('JSON Lines output requires an array or sequence.');
    default: {
      const exhaustive: never = source;
      throw new Error(`Unknown value: ${exhaustive}`);
    }
    }
  }
  default: {
    const exhaustive: never = format;
    throw new Error(`Unknown file format: ${exhaustive}`);
  }
  }
}

async function writeChunks({ directory, path, chunks, onConflict, signal, maxBytes }: {
  directory: FileSystemDirectoryHandle, path: string[], chunks: AsyncIterable<Uint8Array>,
  onConflict: 'error' | 'overwrite', signal: AbortSignal, maxBytes: number,
}): Promise<number> {
  signal.throwIfAborted();
  const parent = await parentDirectory({ directory, path, create: true });
  switch (onConflict) {
  case 'error': {
    let exists = false;
    try {
      await parent.directory.getFileHandle(parent.name);
      exists = true;
    } catch (error) {
      if (!((error instanceof Error || error instanceof DOMException) && error.name === 'NotFoundError')) {
        throw error;
      }
    }
    if (exists) {
      throw new Error('The output file already exists.');
    }
    break;
  }
  case 'overwrite': break;
  default: {
    const exhaustive: never = onConflict;
    throw new Error(`Unknown conflict policy: ${exhaustive}`);
  }
  }
  const handle = await parent.directory.getFileHandle(parent.name, { create: true });
  const writable = await handle.createWritable();
  let bytes = 0;
  try {
    for await (const chunk of chunks) {
      signal.throwIfAborted();
      if (bytes + chunk.byteLength > maxBytes) {
        throw new Error('Workflow file output exceeds its storage budget.');
      }
      await writable.write(chunk.slice());
      bytes += chunk.byteLength;
    }
    signal.throwIfAborted();
    await writable.close();
    return bytes;
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
}

async function saveFile({ source, format, ...destination }: {
  directory: FileSystemDirectoryHandle, path: string[], source: RuntimeValue,
  format: 'text' | 'json' | 'jsonl' | 'binary', onConflict: 'error' | 'overwrite', signal: AbortSignal, maxBytes: number,
}): Promise<number> {
  return writeChunks({ ...destination, chunks: workflowFileChunks({ source, format, signal: destination.signal }) });
}

export type WorkflowWrittenFile = { volumeId: VolumeId, relativePath: string, size: number };

async function* fileChunks({ file, signal }: { file: File, signal: AbortSignal }): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < file.size; offset += 32768) {
    signal.throwIfAborted();
    yield new Uint8Array(await file.slice(offset, offset + 32768).arrayBuffer());
  }
}

/** Only clear runtime-owned staging directories, never a user-selected Volume. */
export async function clearWorkflowStagingDirectory({ directory }: { directory: FileSystemDirectoryHandle }): Promise<void> {
  for await (const [name] of directory.entries()) {
    await directory.removeEntry(name, { recursive: true });
  }
}

/** User-file output is an explicit feature-local side effect, not core DTO persistence.
 * Reuse Volume access; never reinterpret a JSON-selected folder as an access grant.
 */
export function createWorkflowFileServices({ authorize, onWritten }: {
  authorize: ({ volumeId, mode, signal }: { volumeId: VolumeId, mode: 'read' | 'write', signal: AbortSignal }) => Promise<void>,
  onWritten: ({ file }: { file: WorkflowWrittenFile }) => void,
}): Pick<WorkflowRuntimeServices, 'readFile' | 'writeFile'> {
  let remainingWriteBytes = 256 * 1024 * 1024;
  let writes = 0;
  return {
    async readFile({ volumeId, path, signal, store }) {
      await authorize({ volumeId, mode: 'read', signal });
      signal.throwIfAborted();
      const folder = await resolveWorkflowFolder({ volumeId, mode: 'read' });
      try {
        const parent = await parentDirectory({ directory: folder.directory, path, create: false });
        const file = await (await parent.directory.getFileHandle(parent.name)).getFile();
        const writer = await store.createWriter({ signal });
        try {
          for (let offset = 0; offset < file.size; offset += 32768) {
            signal.throwIfAborted();
            await writer.write({ chunk: new Uint8Array(await file.slice(offset, offset + 32768).arrayBuffer()) });
          }
          const output = await writer.seal();
          return {
            content: { type: 'binary', output },
            text: { type: 'text', output: output.retain() },
            metadata: { type: 'json', value: { name: file.name, size: file.size, lastModified: file.lastModified } },
          };
        } catch (error) {
          await writer.abort({ reason: error });
          throw error;
        }
      } finally {
        await folder.close();
      }
    },
    async writeFile({ step, path, source, signal }) {
      if (++writes > 1000) {
        throw new Error('Too many file outputs in one run.');
      }
      await authorize({ volumeId: step.volumeId, mode: 'write', signal });
      signal.throwIfAborted();
      if (!navigator.locks) {
        throw new Error('Web Locks are required for coordinated Workflow file writes.');
      }
      return navigator.locks.request(`naidan-workflow-file-${idToRaw({ id: step.volumeId })}`, { signal }, async () => {
        const folder = await resolveWorkflowFolder({ volumeId: step.volumeId, mode: 'write' });
        try {
          const size = await saveFile({ directory: folder.directory, path, source, format: step.format, onConflict: step.onConflict, signal, maxBytes: Math.min(64 * 1024 * 1024, remainingWriteBytes) });
          remainingWriteBytes -= size;
          onWritten({ file: { volumeId: step.volumeId, relativePath: path.join('/'), size } });
          return { file: { type: 'json', value: { volumeId: idToRaw({ id: step.volumeId }), relativePath: path.join('/'), size } } };
        } finally {
          await folder.close();
        }
      });
    },
  };
}

/** Model values are capabilities with credentials, not downloadable result data.
 * Inspect structural values only: user-owned literal JSON is never silently redacted.
 */
function exportable({ value }: { value: RuntimeValue }): boolean {
  switch (value.type) {
  case 'model': return false;
  case 'json': case 'text': case 'binary': case 'sequence': return true;
  case 'array': return value.items.every(value => exportable({ value }));
  case 'object': return Object.values(value.properties).every(value => exportable({ value }));
  case 'conversation': return value.messages.every(message => message.parts.every(value => exportable({ value })));
  default: {
    const exhaustive: never = value;
    throw new Error(`Unknown value: ${exhaustive}`);
  }
  }
}

function exportFormat({ value }: { value: RuntimeValue }): { format: 'text' | 'json' | 'jsonl' | 'binary', extension: string } {
  switch (value.type) {
  case 'binary': return { format: 'binary', extension: 'bin' };
  case 'text': return { format: 'text', extension: 'txt' };
  case 'sequence': return { format: 'jsonl', extension: 'jsonl' };
  case 'json': case 'array': case 'object': case 'conversation': return { format: 'json', extension: 'json' };
  case 'model': throw new Error('Model connections cannot be exported as result data.');
  default: {
    const exhaustive: never = value;
    throw new Error(`Unknown value: ${exhaustive}`);
  }
  }
}

/** Export to a temporary folder first, allowing Explorer and ZIP to share the same files. */
export async function exportWorkflowResults({ result, directory, signal, writtenFiles }: { result: WorkflowRunResult, directory: FileSystemDirectoryHandle, signal: AbortSignal, writtenFiles: readonly WorkflowWrittenFile[] }): Promise<void> {
  let count = 0, remaining = 256 * 1024 * 1024;
  const manifest: { stepId: string, output: string, path: string | null, skipped: string | null }[] = [];
  for (const [stepId, outputs] of result.outputs) {
    for (const [name, source] of Object.entries(outputs)) {
      if (++count > 1000) {
        throw new Error('Too many result files. Use explicit file outputs inside loops.');
      }
      if (!exportable({ value: source })) {
        manifest.push({ stepId: idToRaw({ id: stepId }), output: name, path: null, skipped: 'Contains a model connection; credentials are not exported.' });
        continue;
      }
      const { format, extension } = exportFormat({ value: source });
      // Imported IDs and output names are labels, not trusted path segments.
      const path = `result-${String(count).padStart(4, '0')}.${extension}`;
      remaining -= await saveFile({ directory, path: [path], source, format, onConflict: 'error', signal, maxBytes: Math.min(64 * 1024 * 1024, remaining) });
      manifest.push({ stepId: idToRaw({ id: stepId }), output: name, path, skipped: null });
    }
  }
  const volumeIndices = new Map<VolumeId, number>();
  const savedFiles = [];
  if (writtenFiles.length > 1000) {
    throw new Error('Too many saved files to export.');
  }
  // These are locations, not immutable outputs. Capture their current contents
  // only when the user explicitly opens/downloads results, not an entire Volume.
  for (const saved of writtenFiles) {
    signal.throwIfAborted();
    const parts = safeRelativePath({ path: saved.relativePath });
    const folderIndex = volumeIndices.get(saved.volumeId) ?? volumeIndices.size + 1;
    volumeIndices.set(saved.volumeId, folderIndex);
    const path = ['files', `folder-${folderIndex}`, ...parts];
    const folder = await resolveWorkflowFolder({ volumeId: saved.volumeId, mode: 'read' });
    try {
      const parent = await parentDirectory({ directory: folder.directory, path: parts, create: false });
      const file = await (await parent.directory.getFileHandle(parent.name)).getFile();
      const size = await writeChunks({ directory, path, chunks: fileChunks({ file, signal }), onConflict: 'error', signal, maxBytes: Math.min(64 * 1024 * 1024, remaining) });
      remaining -= size;
      savedFiles.push({ volumeId: idToRaw({ id: saved.volumeId }), relativePath: saved.relativePath, path: path.join('/'), size });
    } finally {
      await folder.close();
    }
  }
  await saveFile({ directory, path: ['index.json'], source: { type: 'json', value: { status: result.status, outputs: manifest, savedFiles } }, format: 'json', onConflict: 'error', signal, maxBytes: remaining });
}

export async function zipWorkflowFolder({ directory, zipDirectory, signal }: { directory: FileSystemDirectoryHandle, zipDirectory: FileSystemDirectoryHandle, signal: AbortSignal }): Promise<File> {
  const locate = async ({ path }: { path: string }): Promise<FileSystemDirectoryHandle> => {
    let handle = directory;
    for (const segment of path.split('/').filter(Boolean)) {
      handle = await handle.getDirectoryHandle(segment);
    }
    return handle;
  };
  const archive = await createFileExplorerDirectoryArchive({
    sourceRootPath: '/',
    archiveRootName: 'workflow-results',
    excludedRelativePaths: [],
    signal,
    access: {
      async listDirectory({ path }) {
        const entries = [];
        for await (const handle of (await locate({ path })).values()) {
          entries.push({ name: handle.name, kind: handle.kind, modifiedAt: undefined });
        }
        return entries;
      },
      async openFileStream({ path }) {
        const parts = path.split('/').filter(Boolean), name = parts.pop()!;
        return (await (await (await locate({ path: parts.join('/') })).getFileHandle(name)).getFile()).stream();
      },
    },
  });
  // Observe producer errors immediately. The public ZIP utility supplies bounded bytes;
  // staging to a File also avoids the download helper's whole-stream Blob fallback.
  const completed = archive.completed.then(value => ({ type: 'ok' as const, value }), error => ({ type: 'error' as const, error }));
  const file = await zipDirectory.getFileHandle('workflow-results.zip', { create: true });
  const writable = await file.createWritable();
  try {
    await archive.stream.pipeTo(writable, { signal });
    const result = await completed;
    switch (result.type) {
    case 'error': throw result.error;
    case 'ok': break;
    default: {
      const exhaustive: never = result;
      throw new Error(`Unknown archive result: ${exhaustive}`);
    }
    }
    if (result.value.skippedEntryCount) {
      throw new Error('Some result files could not be archived.');
    }
    return await file.getFile();
  } catch (error) {
    await archive.stream.cancel(error).catch(() => undefined);
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
}

export const TEST_ONLY = {
  saveFile,
  exportable,
};
