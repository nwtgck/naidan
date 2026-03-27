import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('worker-hub-standalone-loader', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('creates a blob-backed worker from the embedded script', async () => {
    document.body.innerHTML = `\
<script id="file-protocol-compatible-standalone-worker-hub" type="text/x-naidan-worker">self.onmessage=function(){}</script>`

    const WorkerMock = vi.fn()
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:standalone-worker-hub')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.stubGlobal('Worker', WorkerMock)

    const { createFileProtocolCompatibleStandaloneWorkerHub } = await import('./worker-hub-standalone-loader')
    createFileProtocolCompatibleStandaloneWorkerHub({})

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(WorkerMock).toHaveBeenCalledWith('blob:standalone-worker-hub', {
      name: 'file-protocol-compatible-standalone-worker-hub',
    })
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:standalone-worker-hub')
  })
})
