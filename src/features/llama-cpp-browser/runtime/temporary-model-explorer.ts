import type { TemporaryModelDirectory } from '@/01-models/temporary-model-files';
import { temporaryModelFiles } from '@/logic/temporary-model-files';
import { createRemoteDirectoryAccess, type RemoteDirectoryEntry } from '@/utils/remote-directory-handle';
import type { FileExplorerRemoteMount } from '@/features/file-explorer/worker/types';
import { localRepositories } from './local-repository-store';

export function temporaryModelExplorerMount({ root: captured, path }: { root: TemporaryModelDirectory, path: string }): FileExplorerRemoteMount {
  let root = captured;
  let source = localRepositories.sourceForRoot({ root });
  const rootEntry = { kind: 'directory', name: root.rootName, id: 'directory:' } as const;

  function directoryPath({ id }: { id: string }): string {
    if (!id.startsWith('directory:')) {
      throw new DOMException('The entry is not a directory', 'TypeMismatchError');
    }
    const directory = id.slice('directory:'.length);
    if (directory && !root.files.some(file => file.relativePath.startsWith(`${directory}/`))) {
      throw new DOMException('The directory no longer exists', 'NotFoundError');
    }
    return directory;
  }

  function children({ id }: { id: string }): RemoteDirectoryEntry[] {
    const directory = directoryPath({ id });
    const prefix = directory ? `${directory}/` : '';
    const entries = new Map<string, RemoteDirectoryEntry>();
    for (const { relativePath } of root.files) {
      if (!relativePath.startsWith(prefix)) {
        continue;
      }
      const [name, descendant] = relativePath.slice(prefix.length).split('/', 2);
      const kind = descendant === undefined ? 'file' : 'directory';
      entries.set(name!, { kind, name: name!, id: `${kind}:${prefix}${name}` });
    }
    return [...entries.values()];
  }

  function getEntry({ parentId, name, create, kind }: {
    parentId: string, name: string, create: boolean, kind: RemoteDirectoryEntry['kind'],
  }): RemoteDirectoryEntry {
    if (create) {
      throw new DOMException('Add files from the model selector', 'NotSupportedError');
    }
    const entry = children({ id: parentId }).find(child => child.name === name);
    if (!entry) {
      throw new DOMException('The entry no longer exists', 'NotFoundError');
    }
    if (entry.kind !== kind) {
      throw new DOMException('The entry has a different type', 'TypeMismatchError');
    }
    return entry;
  }

  const access = createRemoteDirectoryAccess({
    async dispatch({ request }) {
      if (temporaryModelFiles.get({ rootPath: root.rootPath }) !== root) {
        throw new DOMException('The temporary model folder has changed', 'NotFoundError');
      }
      switch (request.type) {
      case 'list': return { kind: 'entries', entries: children({ id: request.id }) };
      case 'get_directory': return { kind: 'entry', entry: getEntry({ parentId: request.parentId, name: request.name, create: request.create, kind: 'directory' }) };
      case 'get_file': return { kind: 'entry', entry: getEntry({ parentId: request.parentId, name: request.name, create: request.create, kind: 'file' }) };
      case 'get_file_content': {
        const file = root.files.find(entry => `file:${entry.relativePath}` === request.id)?.file;
        if (!file) {
          throw new DOMException('The file no longer exists', 'NotFoundError');
        }
        return { kind: 'file', file: { blob: file, name: file.name, lastModified: file.lastModified } };
      }
      case 'is_same_entry': return { kind: 'boolean', value: request.firstId === request.secondId };
      case 'resolve': {
        const parent = directoryPath({ id: request.directoryId });
        const target = request.targetId.slice(request.targetId.indexOf(':') + 1);
        const prefix = parent ? `${parent}/` : '';
        return { kind: 'path', path: target === parent ? [] : target.startsWith(prefix) ? target.slice(prefix.length).split('/') : null };
      }
      case 'remove_entry': {
        const directory = directoryPath({ id: request.parentId });
        const target = directory ? `${directory}/${request.name}` : request.name;
        const paths = new Set(root.files.filter(file => file.relativePath === target || file.relativePath.startsWith(`${target}/`)).map(file => file.relativePath));
        if (paths.size === 0) {
          throw new DOMException('The entry no longer exists', 'NotFoundError');
        }
        if (!request.recursive && !paths.has(target)) {
          throw new DOMException('The directory is not empty', 'InvalidModificationError');
        }
        if (source) {
          source = localRepositories.removeFiles({ source, paths });
          root = source.root;
        } else {
          root = temporaryModelFiles.subtractFiles({ root, paths, prepare() {} });
        }
        return { kind: 'void' };
      }
      case 'open_writer': case 'write': case 'seek': case 'truncate': case 'close': case 'abort':
        throw new DOMException('Add files from the model selector', 'NotSupportedError');
      default: throw new Error(String(request satisfies never));
      }
    },
  });
  return { path, root: rootEntry, access, readOnly: false, deletionOnly: true };
}

export const TEST_ONLY = {
};
