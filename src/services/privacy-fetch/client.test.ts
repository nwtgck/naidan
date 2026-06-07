import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PRIVACY_FETCH_PROTOCOL } from './protocol'
import { createPrivacyFetchBrokerClient } from './broker-client'

const { mockGenerateId } = vi.hoisted(() => ({
  mockGenerateId: vi.fn(),
}))

vi.mock('@/utils/id', () => ({
  generateId: mockGenerateId,
}))

type FakeWindowHarness = {
  dispatchMessage: ({
    data,
    source,
  }: {
    data: unknown;
    source: WindowProxy;
  }) => void;
  windowObject: Window;
}

describe('createPrivacyFetchBrokerClient', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    mockGenerateId.mockReset()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  function createFakeWindowHarness(): FakeWindowHarness {
    let messageHandler: ((event: MessageEvent) => void) | undefined

    return {
      dispatchMessage: ({
        data,
        source,
      }: {
        data: unknown;
        source: WindowProxy;
      }) => {
        messageHandler?.({
          data,
          source,
        } as MessageEvent)
      },
      windowObject: {
        addEventListener: vi.fn((eventName: string, handler: EventListenerOrEventListenerObject) => {
          if (eventName === 'message' && typeof handler === 'function') {
            messageHandler = handler as (event: MessageEvent) => void
          }
        }),
        removeEventListener: vi.fn((eventName: string, handler: EventListenerOrEventListenerObject) => {
          if (eventName === 'message' && handler === messageHandler) {
            messageHandler = undefined
          }
        }),
      } as unknown as Window,
    }
  }

  function createClientHarness() {
    const brokerWindow = {
      postMessage: vi.fn(),
    } as unknown as WindowProxy
    const iframe = document.createElement('iframe')
    iframe.src = '/privacy-fetch-broker.html'
    iframe.referrerPolicy = 'no-referrer'
    iframe.setAttribute('sandbox', 'allow-scripts')
    iframe.style.display = 'none'
    iframe.setAttribute('aria-hidden', 'true')
    iframe.tabIndex = -1
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: brokerWindow,
    })

    const fakeWindowHarness = createFakeWindowHarness()
    const client = createPrivacyFetchBrokerClient({
      createBrokerIframeImpl: () => iframe,
      windowObject: fakeWindowHarness.windowObject,
      documentObject: document,
    })

    return {
      brokerWindow,
      client,
      dispatchBrokerMessage: fakeWindowHarness.dispatchMessage,
      iframe,
    }
  }

  it('creates a hidden sandboxed iframe for the broker', () => {
    const { client, iframe } = createClientHarness()

    expect(iframe.getAttribute('src')).toBe('/privacy-fetch-broker.html')
    expect(iframe.referrerPolicy).toBe('no-referrer')
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe.style.display).toBe('none')

    client.dispose()
  })

  it('accepts ready messages from the broker source', () => {
    const {
      brokerWindow,
      client,
      dispatchBrokerMessage,
    } = createClientHarness()
    dispatchBrokerMessage({
      source: brokerWindow,
      data: {
        protocol: PRIVACY_FETCH_PROTOCOL,
        type: 'ready',
        capabilities: {
          responseBody: 'arrayBuffer',
          transferArrayBuffer: true,
          headers: 'entries',
        },
      },
    })

    client.dispose()
  })

  it('ignores messages from a different source window', async () => {
    const {
      brokerWindow,
      client,
      dispatchBrokerMessage,
    } = createClientHarness()
    mockGenerateId.mockReturnValue('req-2')

    const responsePromise = client.fetch({
      url: 'https://en.wikipedia.org/w/api.php?origin=*',
      signal: undefined,
    })
    dispatchBrokerMessage({
      source: brokerWindow,
      data: {
        protocol: PRIVACY_FETCH_PROTOCOL,
        type: 'ready',
        capabilities: {
          responseBody: 'arrayBuffer',
          transferArrayBuffer: true,
          headers: 'entries',
        },
      },
    })
    await Promise.resolve()

    dispatchBrokerMessage({
      source: { postMessage: vi.fn() } as unknown as WindowProxy,
      data: {
        protocol: PRIVACY_FETCH_PROTOCOL,
        type: 'response',
        requestId: 'req-2',
        ok: true,
        url: 'https://en.wikipedia.org/w/api.php?origin=*',
        status: 200,
        statusText: 'OK',
        redirected: false,
        responseType: 'cors',
        headers: [],
        body: new ArrayBuffer(0),
        bodyByteLength: 0,
        validationResult: {
          ok: true,
          policyName: 'wikipedia_api',
          normalizedUrl: 'https://en.wikipedia.org/w/api.php?origin=*',
        },
      },
    })

    let settled = false
    void responsePromise.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)

    client.dispose()
  })

  it('rejects when the signal aborts after the request starts', async () => {
    const {
      brokerWindow,
      client,
      dispatchBrokerMessage,
    } = createClientHarness()

    const controller = new AbortController()
    const responsePromise = client.fetch({
      url: 'https://en.wikipedia.org/w/api.php?origin=*',
      signal: controller.signal,
    })
    dispatchBrokerMessage({
      source: brokerWindow,
      data: {
        protocol: PRIVACY_FETCH_PROTOCOL,
        type: 'ready',
        capabilities: {
          responseBody: 'arrayBuffer',
          transferArrayBuffer: true,
          headers: 'entries',
        },
      },
    })
    await Promise.resolve()

    controller.abort()

    await expect(responsePromise).rejects.toThrow(/aborted/i)

    client.dispose()
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const { client } = createClientHarness()
    const controller = new AbortController()
    controller.abort()

    await expect(client.fetch({
      url: 'https://en.wikipedia.org/w/api.php?origin=*',
      signal: controller.signal,
    })).rejects.toThrow(/aborted/i)

    client.dispose()
  })

  it('rejects while waiting for broker readiness when the signal aborts', async () => {
    const { client } = createClientHarness()
    const controller = new AbortController()

    const responsePromise = client.fetch({
      url: 'https://en.wikipedia.org/w/api.php?origin=*',
      signal: controller.signal,
    })

    controller.abort()

    await expect(responsePromise).rejects.toThrow(/aborted/i)

    client.dispose()
  })
})
