import type { WeshDirEntry, WeshFileHandle, WeshOpenFlags, WeshStat, WeshVirtualMountProvider } from '@/services/wesh/types'
import { NAIDAN_SYSFS_ROOT_PATH } from './constants'
import { createRootEntry } from './entries/root'
import type { NaidanSysfsContext, NaidanSysfsDirectoryEntry, NaidanSysfsEntry, NaidanSysfsStorageReader } from './types'

export class NaidanSysfsProvider implements WeshVirtualMountProvider {
  private readonly context: NaidanSysfsContext
  private readonly rootEntry: NaidanSysfsDirectoryEntry

  constructor({
    reader,
    visibility,
    currentChatId,
    currentChatGroupId,
  }: {
    reader: NaidanSysfsStorageReader;
    visibility: import('@/services/wesh/types').NaidanSysfsVisibility;
    currentChatId: string;
    currentChatGroupId: string | undefined;
  }) {
    this.context = { reader, visibility, currentChatId, currentChatGroupId }
    this.rootEntry = createRootEntry({})
  }

  async open({
    path,
    flags,
    mode,
  }: {
    path: string;
    flags: WeshOpenFlags;
    mode?: number;
  }): Promise<WeshFileHandle> {
    void mode
    const entry = await this.resolveEntry({
      path,
      followFinalSymlink: true,
    })
    switch (entry.kind) {
    case 'file':
      return entry.open({ path, flags })
    case 'directory':
    case 'symlink':
    case 'restricted-directory':
      throw new Error(`Not a file: ${path}`)
    default: {
      const _ex: never = entry
      throw new Error(`Unhandled sysfs entry: ${String(_ex)}`)
    }
    }
  }

  async stat({ path }: { path: string }): Promise<WeshStat> {
    const entry = await this.resolveEntry({
      path,
      followFinalSymlink: true,
    })
    return entry.stat({ path })
  }

  async lstat({ path }: { path: string }): Promise<WeshStat> {
    const entry = await this.resolveEntry({
      path,
      followFinalSymlink: false,
    })
    return entry.stat({ path })
  }

  async *readDir({ path }: { path: string }): AsyncIterable<WeshDirEntry> {
    const entry = await this.resolveEntry({
      path,
      followFinalSymlink: true,
    })
    switch (entry.kind) {
    case 'directory':
      yield* entry.readDir({ path, context: this.context })
      return
    case 'restricted-directory':
      yield* entry.readDir({ path })
      return
    case 'file':
    case 'symlink':
      throw new Error(`Not a directory: ${path}`)
    default: {
      const _ex: never = entry
      throw new Error(`Unhandled sysfs entry: ${String(_ex)}`)
    }
    }
  }

  async readlink({ path }: { path: string }): Promise<string> {
    const entry = await this.resolveEntry({
      path,
      followFinalSymlink: false,
    })
    switch (entry.kind) {
    case 'symlink':
      return entry.readlink({ path })
    case 'directory':
    case 'file':
    case 'restricted-directory':
      throw new Error(`Invalid argument: ${path}`)
    default: {
      const _ex: never = entry
      throw new Error(`Unhandled sysfs entry: ${String(_ex)}`)
    }
    }
  }

  private async resolveEntry({
    path,
    followFinalSymlink,
  }: {
    path: string;
    followFinalSymlink: boolean;
  }): Promise<NaidanSysfsEntry> {
    if (path === NAIDAN_SYSFS_ROOT_PATH) {
      return this.rootEntry
    }

    const segments = this.stripPrefix({ path })
    let entry: NaidanSysfsEntry = this.rootEntry
    let currentPath: string = NAIDAN_SYSFS_ROOT_PATH

    for (const name of segments) {
      switch (entry.kind) {
      case 'directory': {
        const child = await entry.getChild({
          name,
          parentPath: currentPath,
          context: this.context,
        })
        if (child === undefined) {
          throw new Error(`Path not found: ${path}`)
        }
        currentPath = `${currentPath}/${name}`
        entry = child
        break
      }
      case 'file':
      case 'symlink':
      case 'restricted-directory':
        throw new Error(`Not a directory: ${currentPath}`)
      default: {
        const _ex: never = entry
        throw new Error(`Unhandled sysfs entry: ${String(_ex)}`)
      }
      }
    }

    switch (entry.kind) {
    case 'symlink':
      if (followFinalSymlink) {
        return this.resolveEntry({
          path: await entry.readlink({ path: currentPath }),
          followFinalSymlink,
        })
      }
      return entry
    case 'directory':
    case 'file':
    case 'restricted-directory':
      return entry
    default: {
      const _ex: never = entry
      throw new Error(`Unhandled sysfs entry: ${String(_ex)}`)
    }
    }
  }

  private stripPrefix({ path }: { path: string }): string[] {
    if (path === NAIDAN_SYSFS_ROOT_PATH) {
      return []
    }
    const prefix = `${NAIDAN_SYSFS_ROOT_PATH}/`
    if (!path.startsWith(prefix)) {
      throw new Error(`Path not found: ${path}`)
    }
    return path.slice(prefix.length).split('/').filter(segment => segment.length > 0)
  }
}
