import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('worker-hub-standalone-loader', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('creates a blob-backed worker from the embedded script', async () => {
    document.body.innerHTML = `\
<script id="file-protocol-compatible-standalone-worker-hub" type="text/x-naidan-worker">self.onmessage=function(){}</script>
<script id="naidan-standalone-worker-manifest" type="application/json">{"file-protocol-compatible-standalone-worker-hub":{"hash":"abc123","size":33}}</script>`

    const WorkerMock = vi.fn()
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:standalone-worker-hub')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.stubGlobal('Worker', WorkerMock)

    const { createFileProtocolCompatibleStandaloneWorkerHub } = await import('./worker-hub-standalone-loader')
    await createFileProtocolCompatibleStandaloneWorkerHub({})

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(WorkerMock).toHaveBeenCalledWith('blob:standalone-worker-hub', {
      name: 'file-protocol-compatible-standalone-worker-hub',
    })
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:standalone-worker-hub')
  })

  it('prefers the OPFS-cached worker file when available', async () => {
    document.body.innerHTML = `\
<script id="file-protocol-compatible-standalone-worker-hub" type="text/x-naidan-worker">self.onmessage=function(){throw new Error('embedded should not be used')}</script>
<script id="naidan-standalone-worker-manifest" type="application/json">{"file-protocol-compatible-standalone-worker-hub":{"hash":"cachedhash","size":12}}</script>`

    const cachedFile = new File(['cached worker'], 'file-protocol-compatible-standalone-worker-hub.0.27.1-dev.cachedhash.js', {
      type: 'text/javascript',
    })

    const rootHandle = {
      getDirectoryHandle: vi.fn(async (name: string) => {
        if (name === 'naidan-cache') {
          return {
            getDirectoryHandle: vi.fn(async () => ({
              getFileHandle: vi.fn(async () => ({
                getFile: vi.fn(async () => cachedFile),
              })),
            })),
          }
        }
        throw new Error(`Unexpected directory: ${name}`)
      }),
    }

    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn(async () => rootHandle),
      },
    })

    const WorkerMock = vi.fn()
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:cached-worker')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.stubGlobal('Worker', WorkerMock)

    const { createFileProtocolCompatibleStandaloneWorkerHub } = await import('./worker-hub-standalone-loader')
    await createFileProtocolCompatibleStandaloneWorkerHub({})

    expect(createObjectURL).toHaveBeenCalledWith(cachedFile)
    expect(WorkerMock).toHaveBeenCalledWith('blob:cached-worker', {
      name: 'file-protocol-compatible-standalone-worker-hub',
    })
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:cached-worker')
  })
})
