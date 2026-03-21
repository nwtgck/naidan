import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('wesh-worker-loader-standalone', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('creates a blob-backed worker from the embedded script', async () => {
    document.body.innerHTML = `\
<script type="text/x-naidan-worker" data-worker-id="file-protocol-compatible-wesh-worker">self.onmessage=function(){}</script>`

    const WorkerMock = vi.fn()
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:wesh-worker')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.stubGlobal('Worker', WorkerMock)

    const { createFileProtocolCompatibleWeshWorker } = await import('./wesh-worker-loader-standalone')
    createFileProtocolCompatibleWeshWorker()

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(WorkerMock).toHaveBeenCalledWith('blob:wesh-worker', {
      name: 'file-protocol-compatible-wesh-worker',
    })
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:wesh-worker')
  })
})
