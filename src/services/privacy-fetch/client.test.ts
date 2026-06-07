import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PRIVACY_FETCH_PROTOCOL } from './protocol'
import { createPrivacyFetchBrokerClient } from './client'

describe('createPrivacyFetchBrokerClient', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  function dispatchBrokerMessage({
    brokerWindow,
    data,
  }: {
    brokerWindow: WindowProxy;
    data: unknown;
  }): void {
    const event = new MessageEvent('message', {
      data,
      origin: 'null',
    })
    Object.defineProperty(event, 'source', {
      value: brokerWindow,
    })
    window.dispatchEvent(event)
  }

  function createClientHarness() {
    const brokerWindow = {
      postMessage: vi.fn(),
    } as unknown as WindowProxy

    const client = createPrivacyFetchBrokerClient({
      windowObject: window,
      documentObject: document,
    })

    const iframe = document.querySelector('iframe')
    if (!(iframe instanceof HTMLIFrameElement)) {
      throw new Error('Expected broker iframe to be created')
    }

    Object.defineProperty(iframe, 'contentWindow', {
      value: brokerWindow,
      configurable: true,
    })

    return {
      brokerWindow,
      client,
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

  it('sends requests after the broker is ready and resolves array buffer responses', async () => {
    const { brokerWindow, client } = createClientHarness()
    dispatchBrokerMessage({
      brokerWindow,
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

    const responsePromise = client.fetch({
      url: 'https://en.wikipedia.org/w/api.php?origin=*',
      signal: undefined,
      timeoutMs: 1_000,
    })
    await Promise.resolve()

    expect(brokerWindow.postMessage).toHaveBeenCalledWith({
      protocol: PRIVACY_FETCH_PROTOCOL,
      type: 'request',
      requestId: expect.any(String),
      url: 'https://en.wikipedia.org/w/api.php?origin=*',
    }, '*')

    const requestId = (brokerWindow.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.requestId as string
    const body = new TextEncoder().encode('{"ok":true}').buffer
    dispatchBrokerMessage({
      brokerWindow,
      data: {
        protocol: PRIVACY_FETCH_PROTOCOL,
        type: 'response',
        requestId,
        ok: true,
        url: 'https://en.wikipedia.org/w/api.php?origin=*',
        status: 200,
        statusText: 'OK',
        redirected: false,
        responseType: 'cors',
        headers: [['content-type', 'application/json']],
        body,
        bodyByteLength: body.byteLength,
        validationResult: {
          ok: true,
          policyName: 'wikipedia_api',
          normalizedUrl: 'https://en.wikipedia.org/w/api.php?origin=*',
        },
      },
    })

    await expect(responsePromise).resolves.toMatchObject({
      status: 200,
      policyName: 'wikipedia_api',
      headers: [['content-type', 'application/json']],
      bodyByteLength: body.byteLength,
    })

    client.dispose()
  })

  it('ignores messages from a different source window', async () => {
    const { brokerWindow, client } = createClientHarness()
    dispatchBrokerMessage({
      brokerWindow,
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

    const responsePromise = client.fetch({
      url: 'https://en.wikipedia.org/w/api.php?origin=*',
      signal: undefined,
      timeoutMs: 50,
    })

    const requestId = (brokerWindow.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.requestId as string
    dispatchBrokerMessage({
      brokerWindow: { postMessage: vi.fn() } as unknown as WindowProxy,
      data: {
        protocol: PRIVACY_FETCH_PROTOCOL,
        type: 'response',
        requestId,
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

    await expect(responsePromise).rejects.toThrow(/timed out/i)

    client.dispose()
  })

  it('sends a cancel message when the signal aborts', async () => {
    const { brokerWindow, client } = createClientHarness()
    dispatchBrokerMessage({
      brokerWindow,
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

    const controller = new AbortController()
    const responsePromise = client.fetch({
      url: 'https://en.wikipedia.org/w/api.php?origin=*',
      signal: controller.signal,
      timeoutMs: 1_000,
    })
    await Promise.resolve()

    const requestId = (brokerWindow.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.requestId as string
    controller.abort()

    await expect(responsePromise).rejects.toThrow(/aborted/i)
    expect(brokerWindow.postMessage).toHaveBeenLastCalledWith({
      protocol: PRIVACY_FETCH_PROTOCOL,
      type: 'cancel',
      requestId,
    }, '*')

    client.dispose()
  })
})
