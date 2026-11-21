import { storageService } from '@/00-storage/service';
import { idToRaw } from '@/01-models/ids';
import type { FileExplorerModalOptions } from '@/features/file-explorer/composables/useFileExplorerModal';
import type { FileExplorerRemoteMount } from '@/features/file-explorer/worker/types';
import type { WeshMount } from '@/features/wesh/types';
import { temporaryModelFiles } from '@/logic/temporary-model-files';
import { repositoryFolder, selectedFile, visitRepositories } from './hugging-face/storage';
import { llamaCppBrowserModelFiles } from './model-files';
import { allowedModelDirectory, existingUserModelDirectory, opfsRoot, type ResolvedModel } from './runtime/model-directory';
import { hostModelRoot, type ModelDestination } from './runtime/model-destination';
import { parsePublicHostModelReference } from './runtime/model-destination-types';
import { hostModelDirectoryAliases } from './runtime/host-model-aliases';
import { isLocalRepositoryRoot } from './local-repository-lifetime';
import { localRepositories } from './runtime/local-repository-store';
import { temporaryModelExplorerMount } from './runtime/temporary-model-explorer';

async function savedUserFolder({ rootName }: { rootName: string }): Promise<FileSystemDirectoryHandle> {
  const parent = await existingUserModelDirectory();
  if (parent === undefined) {
    throw new DOMException('The saved model folder is missing', 'NotFoundError');
  }
  return parent.getDirectoryHandle(rootName);
}

async function explorerLocation({ model }: { model: ResolvedModel }): Promise<{ path: string[], folder: FileSystemDirectoryHandle | undefined, readOnly: boolean }> {
  const { location } = model;
  switch (location.kind) {
  case 'opfs-user': return { path: ['user', location.rootName], folder: await savedUserFolder({ rootName: location.rootName }), readOnly: false };
  case 'hugging-face': return {
    path: ['hf.co', ...location.repository.split('/')],
    folder: await repositoryFolder({ repository: location.repository, create: false }),
    readOnly: false,
  };
  case 'host': {
    const { alias } = parsePublicHostModelReference({ modelId: model.modelId });
    const destination: ModelDestination = { kind: 'host', directoryId: location.directoryId };
    const folder = await repositoryFolder({ repository: location.repository, create: false, destination });
    const writable = await hostModelRoot({ destination, mode: 'readwrite' }).then(() => true, () => false);
    return { path: ['host', encodeURIComponent(alias), ...location.repository.split('/')], folder, readOnly: !writable };
  }
  case 'local-files': return location.savedRootName === undefined
    ? { path: ['~user', location.rootName], folder: undefined, readOnly: false }
    : { path: ['user', location.savedRootName], folder: await savedUserFolder({ rootName: location.savedRootName }), readOnly: false };
  case 'temp': return { path: location.rootPath.split('/'), folder: undefined, readOnly: false };
  default: throw new Error(String(location satisfies never));
  }
}

async function storageMounts({ signal }: { signal: AbortSignal }): Promise<WeshMount[]> {
  // Unlocking a repository grants direct file management, just like opening
  // its storage folder. These user-directed edits deliberately do not acquire
  // Naidan's model download or publication locks.
  const mounts: WeshMount[] = [];
  const user = await existingUserModelDirectory().catch(() => undefined);
  if (user) {
    for await (const [name, handle] of user.entries()) {
      signal.throwIfAborted();
      switch (handle.kind) {
      case 'directory':
        if (allowedModelDirectory({ name })) {
          mounts.push({ type: 'directory', path: `/user/${name}`, handle, readOnly: false });
        }
        break;
      case 'file': break;
      default: throw new Error(String(handle satisfies never));
      }
    }
  }
  // OPFS uses resolve/main on disk. The Model Explorer exposes the same
  // repository path as the public ID and starts inside the selected variant.
  await visitRepositories({
    async visit({ repository, folder }) {
      signal.throwIfAborted();
      mounts.push({ type: 'directory', path: `/hf.co/${repository}`, handle: folder, readOnly: false });
    },
  }).catch(() => undefined);
  const directories = await storageService.loadHostModelDirectories().catch(() => []);
  const aliases = hostModelDirectoryAliases({ directories });
  for (const directory of directories) {
    signal.throwIfAborted();
    const directoryId = idToRaw({ id: directory.id });
    const alias = encodeURIComponent(aliases.get(directoryId)!);
    const destination = { kind: 'host' as const, directoryId };
    const writable = await hostModelRoot({ destination, mode: 'readwrite' }).then(() => true, () => false);
    await visitRepositories({
      destination,
      async visit({ repository, folder }) {
        signal.throwIfAborted();
        mounts.push({ type: 'directory', path: `/host/${alias}/${repository}`, handle: folder, readOnly: !writable });
      },
    }).catch(() => undefined);
  }
  return mounts;
}

export async function createModelFileExplorerOptions({ model, view, title, signal }: {
  model: ResolvedModel, view: 'folder' | 'models', title: string, signal: AbortSignal,
}): Promise<FileExplorerModalOptions> {
  signal.throwIfAborted();
  const { path, folder, readOnly } = await explorerLocation({ model });
  const primary = model.directory.primaryFile;
  const initialPath = primary.relativePath.split('/').slice(0, -1);
  if (folder && primary.storageKind !== 'temp') {
    // The link may have been replaced while details were open. Re-use the
    // physical entry that was inspected, or require the user to reopen details.
    const current = await selectedFile({ folder, path: primary.relativePath, create: false });
    if (!await current.isSameEntry(primary.handle)) {
      throw new DOMException('The model folder has changed', 'NotFoundError');
    }
  }
  signal.throwIfAborted();
  switch (view) {
  case 'folder': {
    if (folder === undefined) {
      throw new DOMException('The model has no storage folder', 'NotFoundError');
    }
    const location = model.location;
    const host = await (async () => {
      switch (location.kind) {
      case 'host': return hostModelRoot({ destination: { kind: 'host', directoryId: location.directoryId }, mode: 'read' });
      case 'opfs-user': case 'hugging-face': case 'local-files': case 'temp': return undefined;
      default: throw new Error(String(location satisfies never));
      }
    })();
    const root = host ?? await opfsRoot();
    const storagePath = await root.resolve(folder);
    signal.throwIfAborted();
    if (storagePath === null) {
      throw new DOMException('The model folder is no longer in the storage root', 'NotFoundError');
    }
    const start = [...storagePath, ...initialPath];
    return host === undefined ? { kind: 'opfs-root', initialPath: start }
      : { kind: 'native-directory', title: root.name, rootName: root.name, handle: root, readOnly, initialPath: start, initialLocked: true };
  }
  case 'models': break;
  default: throw new Error(String(view satisfies never));
  }

  const mounts = await storageMounts({ signal });
  const remoteMounts: FileExplorerRemoteMount[] = [];
  const temporaryRoots = temporaryModelFiles.list();
  if (folder === undefined) {
    const location = model.location;
    if ((location.kind !== 'local-files' && location.kind !== 'temp') || primary.storageKind !== 'temp'
      || !temporaryRoots.some(root => root.rootPath === location.rootPath && root.registrationRevision === primary.registrationRevision)) {
      throw new DOMException('The temporary model folder has changed', 'NotFoundError');
    }
  } else {
    // Override the selected path with its captured directory even when a
    // linked root or an OPFS repository changed during the wider enumeration.
    mounts.push({ type: 'directory', path: `/${path.join('/')}`, handle: folder, readOnly });
  }
  for (const root of temporaryRoots) {
    const local = localRepositories.sourceForRoot({ root });
    if (local !== undefined) {
      remoteMounts.push(temporaryModelExplorerMount({ root, path: `/~user/${local.rootName}` }));
    } else if (!isLocalRepositoryRoot({ root })) {
      remoteMounts.push(temporaryModelExplorerMount({ root, path: `/${root.rootPath}` }));
    }
  }
  signal.throwIfAborted();
  return { kind: 'wesh-mounts', title, rootName: title, mounts, remoteMounts, initialPath: [...path, ...initialPath], initialLocked: true };
}

export function refreshModelFiles(): void {
  llamaCppBrowserModelFiles.notifyFilesChanged();
}

export const TEST_ONLY = {
};
