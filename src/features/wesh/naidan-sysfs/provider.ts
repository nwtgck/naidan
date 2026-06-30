import type { WeshDirEntry, WeshFileHandle, WeshFinalSymlinkTreatment, WeshOpenFlags, WeshStat, WeshVirtualEntryRef, WeshVirtualMountProvider } from '@/features/wesh/types';
import { NAIDAN_SYSFS_ROOT_PATH } from './constants';
import { createRootEntry } from './entries/root';
import type { NaidanSysfsContext, NaidanSysfsDirectoryEntry, NaidanSysfsEntry, NaidanSysfsStorageReader } from './types';
import { toChatGroupId, toChatId } from '@/01-models/ids';

export class NaidanSysfsProvider implements WeshVirtualMountProvider {
  private readonly context: NaidanSysfsContext;
  private readonly rootEntry: NaidanSysfsDirectoryEntry;

  constructor({
    reader,
    visibility,
    binaryObjectAccess,
    currentChatId,
    currentChatGroupId,
  }: {
    reader: NaidanSysfsStorageReader,
    visibility: import('@/features/wesh/types').NaidanSysfsVisibility,
    binaryObjectAccess: import('@/features/wesh/types').NaidanSysfsBinaryObjectAccess,
    currentChatId: string,
    currentChatGroupId: string | undefined,
  }) {
    this.context = {
      reader,
      visibility,
      binaryObjectAccess,
      currentChatId: toChatId({ raw: currentChatId }),
      currentChatGroupId: currentChatGroupId === undefined ? undefined : toChatGroupId({ raw: currentChatGroupId }),
    };
    this.rootEntry = createRootEntry();
  }

  async resolveEntryRef({
    path,
    finalSymlinkTreatment,
  }: {
    path: string,
    finalSymlinkTreatment: WeshFinalSymlinkTreatment,
  }): Promise<WeshVirtualEntryRef> {
    const entry = await this.resolveEntry({
      path,
      finalSymlinkTreatment,
    });
    return this.createVirtualEntryRef({ entry, path });
  }

  async open({
    path,
    flags,
    mode,
  }: {
    path: string,
    flags: WeshOpenFlags,
    mode?: number,
  }): Promise<WeshFileHandle> {
    void mode;
    const entry = await this.resolveEntry({
      path,
      finalSymlinkTreatment: 'follow',
    });
    switch (entry.kind) {
    case 'file':
      return entry.open({ path, flags });
    case 'directory':
    case 'symlink':
    case 'restricted_directory':
      throw new Error(`Not a file: ${path}`);
    default: {
      const _ex: never = entry;
      throw new Error(`Unhandled sysfs entry: ${String(_ex)}`);
    }
    }
  }

  async stat({ path }: { path: string }): Promise<WeshStat> {
    const entry = await this.resolveEntry({
      path,
      finalSymlinkTreatment: 'follow',
    });
    return entry.stat({ path });
  }

  async lstat({ path }: { path: string }): Promise<WeshStat> {
    const entry = await this.resolveEntry({
      path,
      finalSymlinkTreatment: 'no-follow',
    });
    return entry.stat({ path });
  }

  async *readDir({ path }: { path: string }): AsyncIterable<WeshDirEntry> {
    const entry = await this.resolveEntry({
      path,
      finalSymlinkTreatment: 'follow',
    });
    switch (entry.kind) {
    case 'directory':
      yield* entry.readDir({ path, context: this.context });
      return;
    case 'restricted_directory':
      yield* entry.readDir({ path });
      return;
    case 'file':
    case 'symlink':
      throw new Error(`Not a directory: ${path}`);
    default: {
      const _ex: never = entry;
      throw new Error(`Unhandled sysfs entry: ${String(_ex)}`);
    }
    }
  }

  async readlink({ path }: { path: string }): Promise<string> {
    const entry = await this.resolveEntry({
      path,
      finalSymlinkTreatment: 'no-follow',
    });
    switch (entry.kind) {
    case 'symlink':
      return entry.readlink({ path });
    case 'directory':
    case 'file':
    case 'restricted_directory':
      throw new Error(`Invalid argument: ${path}`);
    default: {
      const _ex: never = entry;
      throw new Error(`Unhandled sysfs entry: ${String(_ex)}`);
    }
    }
  }

  private basename({ path }: { path: string }): string {
    if (path === NAIDAN_SYSFS_ROOT_PATH) {
      return 'naidan';
    }
    const segments = path.split('/');
    return segments[segments.length - 1] ?? path;
  }

  private createVirtualEntryRef({
    entry,
    path,
  }: {
    entry: NaidanSysfsEntry,
    path: string,
  }): WeshVirtualEntryRef {
    const name = this.basename({ path });
    switch (entry.kind) {
    case 'file':
      return {
        type: 'file',
        name,
        fullPath: path,
        stat: () => entry.stat({ path }),
        open: ({ flags, mode }) => {
          void mode;
          return entry.open({ path, flags });
        },
      };
    case 'directory':
      return {
        type: 'directory',
        name,
        fullPath: path,
        stat: () => entry.stat({ path }),
        readDir: () => this.readDirectoryChildren({ entry, path }),
      };
    case 'restricted_directory':
      return {
        type: 'directory',
        name,
        fullPath: path,
        stat: () => entry.stat({ path }),
        readDir: () => this.readRestrictedDirectoryChildren({ entry, path }),
      };
    case 'symlink':
      return {
        type: 'symlink',
        name,
        fullPath: path,
        stat: () => entry.stat({ path }),
        readlink: () => entry.readlink({ path }),
      };
    default: {
      const _ex: never = entry;
      throw new Error(`Unhandled sysfs entry: ${String(_ex)}`);
    }
    }
  }

  private async *readDirectoryChildren({
    entry,
    path,
  }: {
    entry: NaidanSysfsDirectoryEntry,
    path: string,
  }): AsyncIterable<WeshVirtualEntryRef> {
    if (entry.readChildren !== undefined) {
      for await (const child of entry.readChildren({
        path,
        context: this.context,
      })) {
        const childPath = `${path}/${child.name}`;
        yield this.createVirtualEntryRef({
          entry: child.entry,
          path: childPath,
        });
      }
      return;
    }

    for await (const child of entry.readDir({
      path,
      context: this.context,
    })) {
      const childEntry = await entry.getChild({
        name: child.name,
        parentPath: path,
        context: this.context,
      });
      if (childEntry === undefined) {
        throw new Error(`Path not found: ${child.fullPath}`);
      }
      yield this.createVirtualEntryRef({
        entry: childEntry,
        path: child.fullPath,
      });
    }
  }

  private async *readRestrictedDirectoryChildren({
    entry,
    path,
  }: {
    entry: Extract<NaidanSysfsEntry, { kind: 'restricted_directory' }>,
    path: string,
  }): AsyncIterable<WeshVirtualEntryRef> {
    for await (const child of entry.readDir({ path })) {
      const childEntry = await this.resolveEntry({
        path: child.fullPath,
        finalSymlinkTreatment: 'no-follow',
      });
      yield this.createVirtualEntryRef({
        entry: childEntry,
        path: child.fullPath,
      });
    }
  }

  private async resolveEntry({
    path,
    finalSymlinkTreatment,
  }: {
    path: string,
    finalSymlinkTreatment: WeshFinalSymlinkTreatment,
  }): Promise<NaidanSysfsEntry> {
    if (path === NAIDAN_SYSFS_ROOT_PATH) {
      return this.rootEntry;
    }

    const segments = this.stripPrefix({ path });
    let entry: NaidanSysfsEntry = this.rootEntry;
    let currentPath: string = NAIDAN_SYSFS_ROOT_PATH;

    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index];
      if (name === undefined) {
        continue;
      }
      switch (entry.kind) {
      case 'directory': {
        const child = await entry.getChild({
          name,
          parentPath: currentPath,
          context: this.context,
        });
        if (child === undefined) {
          throw new Error(`Path not found: ${path}`);
        }
        currentPath = `${currentPath}/${name}`;
        entry = child;
        break;
      }
      case 'symlink': {
        const targetPath = await entry.readlink({ path: currentPath });
        const remainingSegments = segments.slice(index);
        const remainingPath = remainingSegments.join('/');
        return this.resolveEntry({
          path: remainingPath.length === 0 ? targetPath : `${targetPath}/${remainingPath}`,
          finalSymlinkTreatment,
        });
      }
      case 'file':
      case 'restricted_directory':
        throw new Error(`Not a directory: ${currentPath}`);
      default: {
        const _ex: never = entry;
        throw new Error(`Unhandled sysfs entry: ${String(_ex)}`);
      }
      }
    }

    switch (entry.kind) {
    case 'symlink':
      switch (finalSymlinkTreatment) {
      case 'follow':
        return this.resolveEntry({
          path: await entry.readlink({ path: currentPath }),
          finalSymlinkTreatment,
        });
      case 'no-follow':
        return entry;
      default: {
        const _ex: never = finalSymlinkTreatment;
        throw new Error(`Unhandled symlink treatment: ${_ex}`);
      }
      }
    case 'directory':
    case 'file':
    case 'restricted_directory':
      return entry;
    default: {
      const _ex: never = entry;
      throw new Error(`Unhandled sysfs entry: ${String(_ex)}`);
    }
    }
  }

  private stripPrefix({ path }: { path: string }): string[] {
    if (path === NAIDAN_SYSFS_ROOT_PATH) {
      return [];
    }
    const prefix = `${NAIDAN_SYSFS_ROOT_PATH}/`;
    if (!path.startsWith(prefix)) {
      throw new Error(`Path not found: ${path}`);
    }
    return path.slice(prefix.length).split('/').filter(segment => segment.length > 0);
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
