import { describe, it, expect, beforeEach } from 'vitest'
import { createFileExplorerWorker } from './impl'
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem'

describe('file-explorer.worker.impl', () => {
  let worker: ReturnType<typeof createFileExplorerWorker>

  beforeEach(() => {
    worker = createFileExplorerWorker({})
  })

  it('lists native directory entries with metadata', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle('root')
    const fileHandle = await rootHandle.getFileHandle('readme.txt', { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write('hello')
    await writable.close()
    await rootHandle.getDirectoryHandle('docs', { create: true })

    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'native-directory',
          rootName: 'Files',
          handle: rootHandle as unknown as FileSystemDirectoryHandle,
          readOnly: false,
        },
      },
    })

    const response = await worker.readDirectory({
      request: {
        sessionId,
        path: '/',
      },
    })

    expect(response.entries.map(entry => entry.name).sort()).toEqual(['docs', 'readme.txt'])
    expect(response.entries.find(entry => entry.name === 'readme.txt')?.size).toBe(5)
  })

  it('reads text previews and formats JSON', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle('root')
    const fileHandle = await rootHandle.getFileHandle('data.json', { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write('{"a":1}')
    await writable.close()

    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'native-directory',
          rootName: 'Files',
          handle: rootHandle as unknown as FileSystemDirectoryHandle,
          readOnly: false,
        },
      },
    })

    const response = await worker.readPreview({
      request: {
        sessionId,
        path: '/data.json',
        mode: 'bounded',
      },
    })

    expect(response.kind).toBe('text')
    if (response.kind === 'text') {
      expect(response.rawText).toBe('{"a":1}')
      expect(response.displayText).toContain('\n')
    }
  })

  it('creates, copies, moves, and deletes entries inside a session', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle('root')
    await rootHandle.getDirectoryHandle('target', { create: true })

    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'native-directory',
          rootName: 'Files',
          handle: rootHandle as unknown as FileSystemDirectoryHandle,
          readOnly: false,
        },
      },
    })

    await worker.createFile({
      request: {
        sessionId,
        parentPath: '/',
        name: 'source.txt',
      },
    })

    await worker.copyEntries({
      request: {
        sessionId,
        sourcePaths: ['/source.txt'],
        targetDirectoryPath: '/target',
      },
    })

    let targetListing = await worker.readDirectory({
      request: {
        sessionId,
        path: '/target',
      },
    })
    expect(targetListing.entries.map(entry => entry.name)).toContain('source.txt')

    await worker.moveEntries({
      request: {
        sessionId,
        sourcePaths: ['/source.txt'],
        targetDirectoryPath: '/target',
      },
    })

    const rootListing = await worker.readDirectory({
      request: {
        sessionId,
        path: '/',
      },
    })
    expect(rootListing.entries.map(entry => entry.name)).not.toContain('source.txt')

    await worker.deleteEntries({
      request: {
        sessionId,
        paths: ['/target/source.txt'],
      },
    })

    targetListing = await worker.readDirectory({
      request: {
        sessionId,
        path: '/target',
      },
    })
    expect(targetListing.entries.map(entry => entry.name)).not.toContain('source.txt')
  })

  it('exposes virtual directories for wesh mounts roots', async () => {
    const mountHandle = new MockFileSystemDirectoryHandle('project')
    const fileHandle = await mountHandle.getFileHandle('index.ts', { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write('export {}')
    await writable.close()

    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'wesh-mounts',
          rootName: 'Files',
          mounts: [{
            type: 'directory',
            path: '/home/user/project',
            handle: mountHandle as unknown as FileSystemDirectoryHandle,
            readOnly: false,
          }],
        },
      },
    })

    const rootListing = await worker.readDirectory({
      request: {
        sessionId,
        path: '/',
      },
    })
    expect(rootListing.entries.map(entry => entry.name)).toEqual(['home'])

    const mountListing = await worker.readDirectory({
      request: {
        sessionId,
        path: '/home/user/project',
      },
    })
    expect(mountListing.entries.map(entry => entry.name)).toEqual(['index.ts'])
  })
})
