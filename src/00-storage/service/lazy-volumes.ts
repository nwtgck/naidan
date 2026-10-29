import { nanoid } from 'nanoid';
import type { VolumeId } from '@/01-models/ids';
import { generateId } from '@/01-models/id';
import type { Volume } from '@/01-models/types';
import type { LazyVolumeState, ManagedVolumeReference, VolumeAccess } from '@/01-models/volume-access';
import { createRemoteDirectoryAccess, type RemoteDirectoryAccess, type RemoteDirectoryEntry, type RemoteDirectoryRequest, type RemoteDirectoryResult } from '@/utils/remote-directory-handle';
import { writeReadableStreamToFileHandle } from '@/utils/file-system-stream';
import { publishLazyVolumeState, removeLazyVolumeState } from './lazy-volume-state';
import type { IStorageProvider } from './interface';

type NodeBase = {
  name: string,
  parent: DirectoryNode | undefined,
  attached: boolean,
  removing: boolean,
};
type DirectoryNode = NodeBase & {
  kind: 'directory',
  children: Map<string, Node>,
  native: FileSystemDirectoryHandle | undefined,
  opening: Promise<FileSystemDirectoryHandle> | undefined,
};
type FileBacking =
  | { kind: 'file', file: File }
  | { kind: 'copying', file: File, pending: Promise<FileSystemFileHandle> }
  | { kind: 'opfs', handle: FileSystemFileHandle };
type FileNode = NodeBase & {
  kind: 'file',
  backing: FileBacking,
  writer: Writer | undefined,
};
type Node = DirectoryNode | FileNode;
type Writer = {
  id: string,
  node: FileNode,
  stream: FileSystemWritableFileStream | undefined,
  opening: Promise<FileSystemWritableFileStream>,
  cleanup: Promise<void> | undefined,
  ended: boolean,
  tail: Promise<void>,
  connection: Connection,
};
type Connection = {
  closed: boolean,
  readOnly: boolean,
  nodes: Map<string, Node>,
  ids: Map<Node, string>,
  writers: Map<string, Writer>,
  disposal: Promise<void> | undefined,
};
type Entry = {
  volume: Volume,
  root: DirectoryNode,
  pending: Set<FileNode>,
  total: number,
  phase: LazyVolumeState['phase'],
  error: string | undefined,
  published: boolean,
  closed: boolean,
  gate: Promise<void>,
  background: Promise<void> | undefined,
  publication: Promise<void> | undefined,
  retirement: Promise<void> | undefined,
  removal: Promise<void> | undefined,
  controller: AbortController,
  connections: Set<Connection>,
};

export type ManagedVolumeConnection = {
  access: RemoteDirectoryAccess,
  root: RemoteDirectoryEntry,
  dispose(): Promise<void>,
};

function isDirectory(node: Node): node is DirectoryNode {
  switch (node.kind) {
  case 'directory': return true;
  case 'file': return false;
  default: {
    const exhaustive: never = node;
    throw new Error(String(exhaustive));
  }
  }
}

function isFile(node: Node): node is FileNode {
  switch (node.kind) {
  case 'file': return true;
  case 'directory': return false;
  default: {
    const exhaustive: never = node;
    throw new Error(String(exhaustive));
  }
  }
}

function storedHandle({ node }: { node: Node }): FileSystemHandle | undefined {
  if (isDirectory(node)) {
    return node.native;
  }
  const backing = node.backing;
  switch (backing.kind) {
  case 'opfs': return backing.handle;
  case 'file': case 'copying': return undefined;
  default: {
    const exhaustive: never = backing;
    throw new Error(String(exhaustive));
  }
  }
}

function copyInProgress({ node }: { node: Node }): Promise<FileSystemFileHandle>[] {
  if (isDirectory(node)) {
    return [];
  }
  const backing = node.backing;
  switch (backing.kind) {
  case 'copying': return [backing.pending];
  case 'file': case 'opfs': return [];
  default: {
    const exhaustive: never = backing;
    throw new Error(String(exhaustive));
  }
  }
}

function fsError({ name, message }: { name: string, message: string }): DOMException {
  return new DOMException(message, name);
}

function checkName({ name }: { name: string }): void {
  if (name.length === 0 || name === '.' || name === '..' || /[\\/\0]/u.test(name)) {
    throw fsError({ name: 'TypeError', message: 'Invalid filesystem entry name' });
  }
}

function directoryNode({ name, parent, native }: { name: string, parent: DirectoryNode | undefined, native: FileSystemDirectoryHandle | undefined }): DirectoryNode {
  return { kind: 'directory', name, parent, attached: true, removing: false, children: new Map(), native, opening: undefined };
}

function present({ entry, node }: { entry: Entry, node: Node }): boolean {
  if (entry.closed) {
    return false;
  }
  let current: Node | undefined = node;
  while (current !== undefined) {
    if (!current.attached || current.removing) {
      return false;
    }
    current = current.parent;
  }
  return true;
}

function assertPresent({ entry, node }: { entry: Entry, node: Node }): void {
  if (!present({ entry, node })) {
    throw fsError({ name: 'NotFoundError', message: 'The filesystem entry was removed' });
  }
}

async function gate<T>({ entry, operation }: { entry: Entry, operation(): T | Promise<T> }): Promise<T> {
  const pending = entry.gate.then(operation);
  entry.gate = pending.then(() => {}, () => {});
  return pending;
}

function descendants({ node }: { node: Node }): Node[] {
  const nodes: Node[] = [];
  const remaining: Node[] = [node];
  while (remaining.length > 0) {
    const current = remaining.pop();
    if (current === undefined) {
      continue;
    }
    nodes.push(current);
    if (isDirectory(current)) {
      for (const child of current.children.values()) {
        remaining.push(child);
      }
    }
  }
  return nodes;
}

/** One page owns a volume's File references, copy operations and writable streams. */
export function createLazyVolumeManager({ provider }: { provider: IStorageProvider }) {
  const entries = new Map<VolumeId, Entry>();
  let disposed = false;
  let disposal: Promise<void> | undefined;

  function notify({ entry }: { entry: Entry }): void {
    if (!entry.closed) {
      publishLazyVolumeState({
        state: {
          volume: entry.volume,
          phase: entry.phase,
          progress: { processed: entry.total - entry.pending.size, total: entry.total },
          error: entry.error,
        },
      });
    }
  }

  function fail({ entry, error }: { entry: Entry, error: unknown }): void {
    if (!entry.closed) {
      entry.phase = 'failed';
      entry.error = error instanceof Error ? error.message : 'The folder could not be saved';
      notify({ entry });
    }
  }

  async function ensureDirectory({ entry, node }: { entry: Entry, node: DirectoryNode }): Promise<FileSystemDirectoryHandle> {
    if (node.native !== undefined) {
      return node.native;
    }
    if (node.opening !== undefined) {
      return node.opening;
    }
    const pending = (async () => {
      const handle = node.parent === undefined
        ? await provider.ensureVolumeDirectory({ volumeId: entry.volume.id })
        : await (await ensureDirectory({ entry, node: node.parent })).getDirectoryHandle(node.name, { create: true });
      node.native = handle;
      return handle;
    })();
    node.opening = pending;
    try {
      return await pending;
    } finally {
      node.opening = undefined;
    }
  }

  async function publish({ entry }: { entry: Entry }): Promise<void> {
    if (entry.publication !== undefined) {
      return entry.publication;
    }
    const pending = gate({
      entry,
      operation: async () => {
        if (entry.closed || entry.published || entry.pending.size !== 0) {
          return;
        }
        if (descendants({ node: entry.root }).some(node => node.removing || (isFile(node) && node.writer !== undefined))) {
          return;
        }
        for (const node of descendants({ node: entry.root })) {
          if (isDirectory(node)) {
            await ensureDirectory({ entry, node });
          }
        }
        const root = await ensureDirectory({ entry, node: entry.root });
        await provider.publishVolume({ volume: entry.volume, root });
        entry.published = true;
        entry.phase = 'saved';
        entry.error = undefined;
        notify({ entry });
      },
    });
    entry.publication = pending;
    try {
      await pending;
    } finally {
      if (entry.publication === pending) {
        entry.publication = undefined;
      }
    }
  }

  function requestPublication({ entry }: { entry: Entry }): void {
    if (!entry.closed && !entry.published && entry.pending.size === 0) {
      void publish({ entry }).catch(error => fail({ entry, error }));
    }
  }

  async function materialize({ entry, node }: { entry: Entry, node: FileNode }): Promise<FileSystemFileHandle> {
    const admitted = await gate({
      entry,
      operation: () => {
        assertPresent({ entry, node });
        const backing = node.backing;
        switch (backing.kind) {
        case 'opfs': return { pending: Promise.resolve(backing.handle), start: undefined };
        case 'copying': return { pending: backing.pending, start: undefined };
        case 'file': {
          const result = Promise.withResolvers<FileSystemFileHandle>();
          node.backing = { kind: 'copying', file: backing.file, pending: result.promise };
          return { pending: result.promise, start: { file: backing.file, result } };
        }
        default: {
          const exhaustive: never = backing;
          throw new Error(String(exhaustive));
        }
        }
      },
    });
    if (admitted.start !== undefined) {
      const { file, result } = admitted.start;
      void (async () => {
        try {
          const parent = node.parent;
          if (parent === undefined) {
            throw new Error('A volume file must have a parent');
          }
          const directory = await ensureDirectory({ entry, node: parent });
          const handle = await directory.getFileHandle(node.name, { create: true });
          await writeReadableStreamToFileHandle({ source: file.stream(), targetHandle: handle, signal: entry.controller.signal });
          await gate({
            entry,
            operation: () => {
              if (entry.closed) {
                throw fsError({ name: 'AbortError', message: 'The volume was removed' });
              }
              node.backing = { kind: 'opfs', handle };
              entry.pending.delete(node);
              notify({ entry });
            },
          });
          result.resolve(handle);
          requestPublication({ entry });
        } catch (error) {
          await gate({
            entry,
            operation: () => {
              node.backing = { kind: 'file', file };
            },
          });
          result.reject(error);
        }
      })();
    }
    return admitted.pending;
  }

  function startBackground({ entry }: { entry: Entry }): void {
    if (entry.background !== undefined || entry.closed || entry.phase !== 'copying') {
      return;
    }
    const running = Promise.resolve().then(async () => {
      while (!entry.closed && entry.phase === 'copying') {
        let next: FileNode | undefined;
        for (const node of entry.pending) {
          if (present({ entry, node })) {
            next = node;
            break;
          }
        }
        if (next === undefined) {
          break;
        }
        try {
          await materialize({ entry, node: next });
        } catch (error) {
          // A deletion may win the namespace gate after this node was chosen.
          // Its removal owns cleanup; it is not a failure to save other files.
          if (present({ entry, node: next })) {
            throw error;
          }
        }
      }
      if (!entry.closed) {
        await publish({ entry });
      }
    });
    entry.background = running;
    void running.catch(error => fail({ entry, error })).finally(() => {
      if (entry.background === running) {
        entry.background = undefined;
      }
      if (!entry.closed && entry.phase === 'copying') {
        for (const node of entry.pending) {
          if (present({ entry, node })) {
            startBackground({ entry });
            break;
          }
        }
      }
    });
  }

  async function nativeChild({ entry, parent, name, kind, create }: {
    entry: Entry, parent: DirectoryNode, name: string, kind: 'file' | 'directory', create: boolean,
  }): Promise<Node> {
    assertPresent({ entry, node: parent });
    const parentHandle = await ensureDirectory({ entry, node: parent });
    const native = await (() => {
      switch (kind) {
      case 'directory': return parentHandle.getDirectoryHandle(name, { create });
      case 'file': return parentHandle.getFileHandle(name, { create });
      default: {
        const exhaustive: never = kind;
        throw new Error(String(exhaustive));
      }
      }
    })();
    const cached = parent.children.get(name);
    const cachedNative = cached === undefined ? undefined : storedHandle({ node: cached });
    if (cached !== undefined && cached.attached && cachedNative !== undefined && await cachedNative.isSameEntry(native)) {
      return cached;
    }
    if (cached !== undefined) {
      cached.attached = false;
    }
    const child: Node = (() => {
      switch (native.kind) {
      case 'directory': return directoryNode({ name, parent, native });
      case 'file': return { kind: 'file', name, parent, attached: true, removing: false, backing: { kind: 'opfs', handle: native }, writer: undefined };
      default: {
        const exhaustive: never = native;
        throw new Error(String(exhaustive));
      }
      }
    })();
    parent.children.set(name, child);
    return child;
  }

  async function lookup({ entry, parent, name, kind, create }: {
    entry: Entry, parent: DirectoryNode, name: string, kind: 'file' | 'directory', create: boolean,
  }): Promise<Node> {
    checkName({ name });
    return gate({
      entry,
      operation: async () => {
        assertPresent({ entry, node: parent });
        if (entry.published) {
          return nativeChild({ entry, parent, name, kind, create });
        }
        const existing = parent.children.get(name);
        if (existing !== undefined) {
          assertPresent({ entry, node: existing });
          if (existing.kind !== kind) {
            throw fsError({ name: 'TypeMismatchError', message: 'The entry has a different kind' });
          }
          return existing;
        }
        if (!create) {
          throw fsError({ name: 'NotFoundError', message: 'The filesystem entry does not exist' });
        }
        const directory = await ensureDirectory({ entry, node: parent });
        const child: Node = await (async () => {
          switch (kind) {
          case 'directory': return directoryNode({ name, parent, native: await directory.getDirectoryHandle(name, { create: true }) });
          case 'file': return { kind: 'file', name, parent, attached: true, removing: false, backing: { kind: 'opfs', handle: await directory.getFileHandle(name, { create: true }) }, writer: undefined };
          default: {
            const exhaustive: never = kind;
            throw new Error(String(exhaustive));
          }
          }
        })();
        parent.children.set(name, child);
        requestPublication({ entry });
        return child;
      },
    });
  }

  async function list({ entry, node }: { entry: Entry, node: DirectoryNode }): Promise<Node[]> {
    return gate({
      entry,
      operation: async () => {
        assertPresent({ entry, node });
        if (entry.published) {
          const handle = await ensureDirectory({ entry, node });
          const result: Node[] = [];
          const names = new Set<string>();
          for await (const child of handle.values()) {
            names.add(child.name);
            result.push(await nativeChild({ entry, parent: node, name: child.name, kind: child.kind, create: false }));
          }
          for (const [name, child] of node.children) {
            if (!names.has(name)) {
              child.attached = false;
              node.children.delete(name);
            }
          }
          return result;
        }
        return [...node.children.values()].filter(child => child.attached && !child.removing);
      },
    });
  }

  async function remove({ entry, parent, name, recursive }: { entry: Entry, parent: DirectoryNode, name: string, recursive: boolean }): Promise<void> {
    checkName({ name });
    const admitted = await gate({
      entry,
      operation: async () => {
        assertPresent({ entry, node: parent });
        let target = parent.children.get(name);
        if (entry.published) {
          const handle = await ensureDirectory({ entry, node: parent });
          let native: FileSystemHandle;
          try {
            native = await handle.getFileHandle(name);
          } catch (error) {
            if (!(error instanceof DOMException) || error.name !== 'TypeMismatchError') {
              throw error;
            }
            native = await handle.getDirectoryHandle(name);
          }
          target = await nativeChild({ entry, parent, name, kind: native.kind, create: false });
        }
        if (target === undefined) {
          throw fsError({ name: 'NotFoundError', message: 'The filesystem entry does not exist' });
        }
        assertPresent({ entry, node: target });
        if (isDirectory(target) && !recursive) {
          let nonempty = target.children.size > 0;
          if (entry.published) {
            nonempty = false;
            const handle = await ensureDirectory({ entry, node: target });
            for await (const _child of handle.values()) {
              nonempty = true;
              break;
            }
          }
          if (nonempty) {
            throw fsError({ name: 'InvalidModificationError', message: 'The directory is not empty' });
          }
        }
        const nodes = descendants({ node: target });
        if (nodes.some(node => isFile(node) && node.writer !== undefined)) {
          throw fsError({ name: 'NoModificationAllowedError', message: 'A file is open for writing' });
        }
        target.removing = true;
        return { target, nodes, pending: nodes.flatMap(node => copyInProgress({ node })) };
      },
    });
    try {
      await Promise.allSettled(admitted.pending);
      await gate({
        entry,
        operation: async () => {
          if (entry.closed) {
            return;
          }
          if (parent.native !== undefined) {
            try {
              await parent.native.removeEntry(name, { recursive });
            } catch (error) {
              if (!(error instanceof DOMException) || error.name !== 'NotFoundError') {
                throw error;
              }
            }
          }
          for (const node of admitted.nodes) {
            node.attached = false;
            if (isFile(node)) {
              entry.pending.delete(node);
            }
          }
          parent.children.delete(name);
          notify({ entry });
        },
      });
    } catch (error) {
      admitted.target.removing = false;
      throw error;
    } finally {
      requestPublication({ entry });
      startBackground({ entry });
    }
  }

  function releaseWriter({ entry, writer }: { entry: Entry, writer: Writer }): void {
    writer.ended = true;
    writer.connection.writers.delete(writer.id);
    if (writer.node.writer === writer) {
      writer.node.writer = undefined;
    }
    requestPublication({ entry });
  }

  async function abortWriter({ entry, writer }: { entry: Entry, writer: Writer }): Promise<void> {
    if (writer.cleanup !== undefined) {
      return writer.cleanup;
    }
    writer.ended = true;
    writer.cleanup = (async () => {
      try {
        const stream = await writer.opening.catch(() => undefined);
        if (stream !== undefined) {
          await writer.tail;
          await stream.abort();
        }
      } finally {
        releaseWriter({ entry, writer });
      }
    })();
    return writer.cleanup;
  }

  async function openWriter({ entry, connection, node, keepExistingData }: {
    entry: Entry, connection: Connection, node: FileNode, keepExistingData: boolean,
  }): Promise<string> {
    const handle = await materialize({ entry, node });
    const writer = await gate({
      entry,
      operation: () => {
        assertPresent({ entry, node });
        if (connection.closed) {
          throw fsError({ name: 'InvalidStateError', message: 'The filesystem connection was closed' });
        }
        if (node.writer !== undefined) {
          throw fsError({ name: 'NoModificationAllowedError', message: 'The file is already open for writing' });
        }
        // Store the opening promise before exposing the reservation so disposal
        // can drain even a native open that resolves after worker termination.
        const created: Writer = { id: nanoid(), node, stream: undefined, opening: Promise.resolve().then(() => handle.createWritable({ keepExistingData })), cleanup: undefined, ended: false, tail: Promise.resolve(), connection };
        node.writer = created;
        connection.writers.set(created.id, created);
        return created;
      },
    });
    try {
      const stream = await writer.opening;
      writer.stream = stream;
      if (writer.ended || connection.closed || entry.closed) {
        await abortWriter({ entry, writer });
        throw fsError({ name: 'AbortError', message: 'The filesystem connection was closed while opening the writer' });
      }
      return writer.id;
    } catch (error) {
      releaseWriter({ entry, writer });
      throw error;
    }
  }

  function disposeConnection({ entry, connection }: { entry: Entry, connection: Connection }): Promise<void> {
    if (connection.disposal !== undefined) {
      return connection.disposal;
    }
    connection.closed = true;
    connection.disposal = (async () => {
      await Promise.all([...connection.writers.values()].map(writer => abortWriter({ entry, writer })));
      connection.nodes.clear();
      connection.ids.clear();
      entry.connections.delete(connection);
    })();
    return connection.disposal;
  }

  function retire({ entry }: { entry: Entry }): Promise<void> {
    if (entry.retirement !== undefined) {
      return entry.retirement;
    }
    entry.closed = true;
    entry.controller.abort();
    entry.retirement = (async () => {
      await Promise.all([...entry.connections].map(connection => disposeConnection({ entry, connection })));
      await Promise.allSettled([...entry.pending].flatMap(node => copyInProgress({ node })));
      await entry.gate;
    })();
    return entry.retirement;
  }

  function connectionFor({ entry, readOnly }: { entry: Entry, readOnly: boolean }): ManagedVolumeConnection {
    const connection: Connection = { closed: false, readOnly, nodes: new Map(), ids: new Map(), writers: new Map(), disposal: undefined };
    entry.connections.add(connection);
    function expose({ node }: { node: Node }): RemoteDirectoryEntry {
      let id = connection.ids.get(node);
      if (id === undefined) {
        id = nanoid();
        connection.ids.set(node, id);
        connection.nodes.set(id, node);
      }
      return { id, name: node.name, kind: node.kind };
    }
    function ownedNode({ id }: { id: string }): Node {
      const node = connection.nodes.get(id);
      if (node === undefined) {
        throw fsError({ name: 'NotAllowedError', message: 'The entry does not belong to this filesystem connection' });
      }
      return node;
    }
    function nodeFor({ id }: { id: string }): Node {
      const node = ownedNode({ id });
      assertPresent({ entry, node });
      return node;
    }
    function directoryFor({ id }: { id: string }): DirectoryNode {
      const node = nodeFor({ id });
      if (!isDirectory(node)) {
        throw fsError({ name: 'TypeMismatchError', message: 'The entry is not a directory' });
      }
      return node;
    }
    function assertWritable(): void {
      if (connection.readOnly) {
        throw fsError({ name: 'NotAllowedError', message: 'The filesystem connection is read-only' });
      }
    }
    function writerFor({ id }: { id: string }): Writer {
      const writer = connection.writers.get(id);
      if (writer === undefined || writer.ended || writer.stream === undefined) {
        throw fsError({ name: 'InvalidStateError', message: 'The writable stream is closed' });
      }
      return writer;
    }
    async function writeOperation({ writer, operation }: { writer: Writer, operation({ stream }: { stream: FileSystemWritableFileStream }): Promise<void> }): Promise<void> {
      const stream = writer.stream;
      if (stream === undefined) {
        throw new Error('The writable stream is not open');
      }
      const pending = writer.tail.then(() => operation({ stream }));
      writer.tail = pending.catch(() => {});
      try {
        await pending;
      } catch (error) {
        try {
          await abortWriter({ entry, writer });
        } catch { /* Preserve the write failure. */ }
        throw error;
      }
    }
    async function dispatch({ request }: { request: RemoteDirectoryRequest }): Promise<RemoteDirectoryResult> {
      if (connection.closed || entry.closed) {
        throw fsError({ name: 'InvalidStateError', message: 'The filesystem connection is closed' });
      }
      switch (request.type) {
      case 'get_directory': {
        if (request.create) {
          assertWritable();
        }
        const child = await lookup({ entry, parent: directoryFor({ id: request.parentId }), name: request.name, kind: 'directory', create: request.create });
        return { kind: 'entry', entry: expose({ node: child }) };
      }
      case 'get_file': {
        if (request.create) {
          assertWritable();
        }
        const child = await lookup({ entry, parent: directoryFor({ id: request.parentId }), name: request.name, kind: 'file', create: request.create });
        return { kind: 'entry', entry: expose({ node: child }) };
      }
      case 'list': return { kind: 'entries', entries: (await list({ entry, node: directoryFor({ id: request.id }) })).map(node => expose({ node })) };
      case 'get_file_content': {
        const node = nodeFor({ id: request.id });
        if (!isFile(node)) {
          throw fsError({ name: 'TypeMismatchError', message: 'The entry is not a file' });
        }
        const backing = node.backing;
        const file = await (() => {
          switch (backing.kind) {
          case 'opfs': return backing.handle.getFile();
          case 'file': case 'copying': return backing.file;
          default: {
            const exhaustive: never = backing;
            throw new Error(String(exhaustive));
          }
          }
        })();
        return { kind: 'file', file: { blob: file, name: file.name, lastModified: file.lastModified } };
      }
      case 'remove_entry':
        assertWritable();
        await remove({ entry, parent: directoryFor({ id: request.parentId }), name: request.name, recursive: request.recursive });
        return { kind: 'void' };
      case 'is_same_entry': return { kind: 'boolean', value: ownedNode({ id: request.firstId }) === ownedNode({ id: request.secondId }) };
      case 'resolve': {
        const directory = directoryFor({ id: request.directoryId });
        let node: Node | undefined = nodeFor({ id: request.targetId });
        const path: string[] = [];
        while (node !== undefined && node !== directory) {
          path.unshift(node.name);
          node = node.parent;
        }
        return { kind: 'path', path: node === directory ? path : null };
      }
      case 'open_writer': {
        assertWritable();
        const node = nodeFor({ id: request.fileId });
        if (!isFile(node)) {
          throw fsError({ name: 'TypeMismatchError', message: 'The entry is not a file' });
        }
        return { kind: 'writer', writerId: await openWriter({ entry, connection, node, keepExistingData: request.keepExistingData }) };
      }
      case 'write':
        assertWritable();
        await writeOperation({ writer: writerFor({ id: request.writerId }), operation: ({ stream }) => stream.write(request.data) });
        return { kind: 'void' };
      case 'seek':
        assertWritable();
        await writeOperation({ writer: writerFor({ id: request.writerId }), operation: ({ stream }) => stream.seek(request.position) });
        return { kind: 'void' };
      case 'truncate':
        assertWritable();
        await writeOperation({ writer: writerFor({ id: request.writerId }), operation: ({ stream }) => stream.truncate(request.size) });
        return { kind: 'void' };
      case 'close': {
        const writer = writerFor({ id: request.writerId });
        try {
          await writeOperation({ writer, operation: ({ stream }) => stream.close() });
        } finally {
          releaseWriter({ entry, writer });
        }
        return { kind: 'void' };
      }
      case 'abort': {
        const writer = connection.writers.get(request.writerId);
        if (writer !== undefined) {
          await abortWriter({ entry, writer });
        }
        return { kind: 'void' };
      }
      default: {
        const exhaustive: never = request;
        throw new Error(String(exhaustive));
      }
      }
    }
    return {
      root: expose({ node: entry.root }),
      access: createRemoteDirectoryAccess({ dispatch }),
      dispose: () => disposeConnection({ entry, connection }),
    };
  }

  return {
    register({ name, files, signal }: { name: string, files: readonly { file: File, relativePath: string }[], signal: AbortSignal | undefined }): Volume {
      if (disposed) {
        throw fsError({ name: 'InvalidStateError', message: 'The volume manager was disposed' });
      }
      signal?.throwIfAborted();
      const root = directoryNode({ name, parent: undefined, native: undefined });
      const pending = new Set<FileNode>();
      for (const file of files) {
        signal?.throwIfAborted();
        const parts = file.relativePath.split('/');
        if (parts.length === 0) {
          throw new TypeError('A file requires a relative path');
        }
        for (const part of parts) {
          checkName({ name: part });
        }
        const fileName = parts.pop();
        if (fileName === undefined) {
          throw new TypeError('A file requires a name');
        }
        let parent = root;
        for (const part of parts) {
          const child = parent.children.get(part);
          if (child !== undefined && child.kind !== 'directory') {
            throw new TypeError('A file conflicts with a parent directory');
          }
          const directory = child ?? directoryNode({ name: part, parent, native: undefined });
          parent.children.set(part, directory);
          parent = directory;
        }
        if (parent.children.has(fileName)) {
          throw new TypeError('Duplicate or conflicting file path');
        }
        const node: FileNode = { kind: 'file', name: fileName, parent, attached: true, removing: false, backing: { kind: 'file', file: file.file }, writer: undefined };
        parent.children.set(fileName, node);
        pending.add(node);
      }
      signal?.throwIfAborted();
      const volume: Volume = { id: generateId<VolumeId>(), name, createdAt: Date.now(), type: 'opfs' };
      const entry: Entry = { volume, root, pending, total: pending.size, phase: 'copying', error: undefined, published: false, closed: false, gate: Promise.resolve(), background: undefined, publication: undefined, retirement: undefined, removal: undefined, controller: new AbortController(), connections: new Set() };
      entries.set(volume.id, entry);
      notify({ entry });
      startBackground({ entry });
      return volume;
    },
    has({ volumeId }: { volumeId: VolumeId }): boolean {
      return entries.has(volumeId);
    },
    hasUnpublished(): boolean {
      return [...entries.values()].some(entry => !entry.published);
    },
    list(): Volume[] {
      return [...entries.values()].map(entry => entry.volume);
    },
    listUnpublished(): Volume[] {
      return [...entries.values()].filter(entry => !entry.published).map(entry => entry.volume);
    },
    async resolveAccess({ volumeId }: { volumeId: VolumeId }): Promise<VolumeAccess | undefined> {
      const entry = entries.get(volumeId);
      if (entry === undefined || entry.closed) {
        return undefined;
      }
      if (!entry.published) {
        return { kind: 'managed', volume: entry.volume, reference: { volumeId } };
      }
      // Saved metadata and root identity belong to OPFS. A peer can delete or
      // replace them while this page retains its adapter and writer leases.
      const stored = await provider.probeVolumeAccess({ volumeId });
      switch (stored.kind) {
      case 'native':
        return entry.root.native !== undefined && await stored.handle.isSameEntry(entry.root.native)
          ? { kind: 'managed', volume: stored.volume, reference: { volumeId } }
          : stored;
      case 'incomplete': case 'missing': return stored;
      default: {
        const exhaustive: never = stored;
        throw new Error(String(exhaustive));
      }
      }
    },
    pause({ volumeId }: { volumeId: VolumeId }): void {
      const entry = entries.get(volumeId);
      if (entry !== undefined && !entry.published) {
        entry.phase = 'paused';
        notify({ entry });
      }
    },
    async retry({ volumeId }: { volumeId: VolumeId }): Promise<void> {
      const entry = entries.get(volumeId);
      if (entry === undefined) {
        throw fsError({ name: 'NotFoundError', message: 'The managed volume does not exist' });
      }
      if (entry.published) {
        return;
      }
      entry.phase = 'copying';
      entry.error = undefined;
      startBackground({ entry });
      notify({ entry });
      await entry.background;
    },
    createAccess({ reference, readOnly }: { reference: ManagedVolumeReference, readOnly: boolean }): ManagedVolumeConnection {
      const entry = entries.get(reference.volumeId);
      if (entry === undefined || entry.closed) {
        throw fsError({ name: 'NotFoundError', message: 'The managed volume does not exist' });
      }
      return connectionFor({ entry, readOnly });
    },
    async rename({ volumeId, name }: { volumeId: VolumeId, name: string }): Promise<void> {
      const entry = entries.get(volumeId);
      if (entry === undefined) {
        throw fsError({ name: 'NotFoundError', message: 'The managed volume does not exist' });
      }
      await gate({
        entry,
        operation: async () => {
          if (entry.published) {
            await provider.renameVolume({ volumeId, name });
          }
          entry.volume = { ...entry.volume, name };
          notify({ entry });
        },
      });
    },
    async remove({ volumeId }: { volumeId: VolumeId }): Promise<void> {
      const entry = entries.get(volumeId);
      if (entry === undefined) {
        return;
      }
      if (entry.removal !== undefined) {
        return entry.removal;
      }
      entry.removal = (async () => {
        await retire({ entry });
        if (entry.published) {
          await provider.deleteVolume({ volumeId });
        } else {
          await provider.deleteUnpublishedVolumeDirectory({ volumeId });
        }
        entries.delete(volumeId);
        removeLazyVolumeState({ volumeId });
      })();
      return entry.removal;
    },
    dispose(): Promise<void> {
      if (disposal !== undefined) {
        return disposal;
      }
      disposed = true;
      const current = [...entries.values()];
      disposal = (async () => {
        await Promise.all(current.map(entry => entry.removal ?? retire({ entry })));
        for (const entry of current) {
          removeLazyVolumeState({ volumeId: entry.volume.id });
        }
        entries.clear();
      })();
      return disposal;
    },
  };
}

export type LazyVolumeManager = ReturnType<typeof createLazyVolumeManager>;

export const TEST_ONLY = {
};
