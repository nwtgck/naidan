import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isPrivacyFetchError } from './errors';
import { PRIVACY_FETCH_PROTOCOL } from './protocol';
import { createPrivacyFetchBrokerClient } from './broker-client';

const { mockGenerateId } = vi.hoisted(() => ({
  mockGenerateId: vi.fn(),
}));

vi.mock('@/01-models/id', () => ({
  generateId: mockGenerateId,
}));

type FakeWindowHarness = {
  dispatchMessage: ({
    data,
    source,
  }: {
    data: unknown,
    source: WindowProxy,
  }) => void,
  windowObject: Window,
};

describe('createPrivacyFetchBrokerClient', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mockGenerateId.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  function createFakeWindowHarness(): FakeWindowHarness {
    let messageHandler: ((event: MessageEvent) => void) | undefined;

    return {
      dispatchMessage: ({
        data,
        source,
      }: {
        data: unknown,
        source: WindowProxy,
      }) => {
        messageHandler?.({
          data,
          source,
        } as MessageEvent);
      },
      windowObject: {
        addEventListener: vi.fn((eventName: string, handler: EventListenerOrEventListenerObject) => {
          if (eventName === 'message' && typeof handler === 'function') {
            messageHandler = handler as (event: MessageEvent) => void;
          }
        }),
        removeEventListener: vi.fn((eventName: string, handler: EventListenerOrEventListenerObject) => {
          if (eventName === 'message' && handler === messageHandler) {
            messageHandler = undefined;
          }
        }),
      } as unknown as Window,
    };
  }

  function createClientHarness() {
    const brokerWindow = {
      postMessage: vi.fn(),
    } as unknown as WindowProxy;
    const iframe = document.createElement('iframe');
    iframe.src = '/privacy-fetch-broker.html';
    iframe.referrerPolicy = 'no-referrer';
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.style.display = 'none';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: brokerWindow,
    });

    const fakeWindowHarness = createFakeWindowHarness();
    const client = createPrivacyFetchBrokerClient({
      createBrokerIframeImpl: () => iframe,
      windowObject: fakeWindowHarness.windowObject,
      documentObject: document,
    });

    return {
      brokerWindow,
      client,
      dispatchBrokerMessage: fakeWindowHarness.dispatchMessage,
      iframe,
    };
  }

  it('creates a hidden sandboxed iframe for the broker', () => {
    const { client, iframe } = createClientHarness();

    expect(iframe.getAttribute('src')).toBe('/privacy-fetch-broker.html');
    expect(iframe.referrerPolicy).toBe('no-referrer');
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.style.display).toBe('none');

    client.dispose();
  });

  it('accepts ready messages from the broker source', () => {
    const {
      brokerWindow,
      client,
      dispatchBrokerMessage,
    } = createClientHarness();
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
    });

    client.dispose();
  });

  it('posts a request after ready and resolves response messages', async () => {
    const {
      brokerWindow,
      client,
      dispatchBrokerMessage,
    } = createClientHarness();
    mockGenerateId.mockReturnValue('req-success');

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
    });

    const responsePromise = client.fetch({
      request: {
        url: 'https://en.wikipedia.org/w/api.php?origin=*',
        signal: undefined,
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(brokerWindow.postMessage).toHaveBeenCalledWith({
      protocol: PRIVACY_FETCH_PROTOCOL,
      type: 'request',
      requestId: 'req-success',
      url: 'https://en.wikipedia.org/w/api.php?origin=*',
    }, '*');

    const body = new TextEncoder().encode('{"ok":true}').buffer;
    dispatchBrokerMessage({
      source: brokerWindow,
      data: {
        protocol: PRIVACY_FETCH_PROTOCOL,
        type: 'response',
        requestId: 'req-success',
        ok: true,
        responseOk: true,
        url: 'https://en.wikipedia.org/w/api.php?origin=*',
        status: 200,
        statusText: 'OK',
        redirected: false,
        responseType: 'cors',
        headers: [
          ['content-type', 'application/json'],
          ['RETRY-AFTER', '5'],
        ],
        body,
        bodyByteLength: body.byteLength,
        validationResult: {
          ok: true,
          policyName: 'wikipedia_api',
          normalizedUrl: 'https://en.wikipedia.org/w/api.php?origin=*',
        },
      },
    });

    const response = await responsePromise;
    expect(response).toMatchObject({
      url: 'https://en.wikipedia.org/w/api.php?origin=*',
      status: 200,
      statusText: 'OK',
      ok: true,
      redirected: false,
      responseType: 'cors',
      body,
      bodyByteLength: body.byteLength,
      policyName: 'wikipedia_api',
    });
    expect(response.headers).toBeInstanceOf(Headers);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('retry-after')).toBe('5');

    client.dispose();
  });

  it('maps responseOk false to PrivacyFetchResponse.ok false', async () => {
    const {
      brokerWindow,
      client,
      dispatchBrokerMessage,
    } = createClientHarness();
    mockGenerateId.mockReturnValue('req-http-false');

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
    });

    const responsePromise = client.fetch({
      request: {
        url: 'https://en.wikipedia.org/w/api.php?origin=*',
        signal: undefined,
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    dispatchBrokerMessage({
      source: brokerWindow,
      data: {
        protocol: PRIVACY_FETCH_PROTOCOL,
        type: 'response',
        requestId: 'req-http-false',
        ok: true,
        responseOk: false,
        url: 'https://en.wikipedia.org/w/api.php?origin=*',
        status: 404,
        statusText: 'Not Found',
        redirected: false,
        responseType: 'cors',
        headers: [['content-type', 'application/json']],
        body: new ArrayBuffer(0),
        bodyByteLength: 0,
        validationResult: {
          ok: true,
          policyName: 'wikipedia_api',
          normalizedUrl: 'https://en.wikipedia.org/w/api.php?origin=*',
        },
      },
    });

    const response = await responsePromise;
    expect(response).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(response.headers).toBeInstanceOf(Headers);
    expect(response.headers.get('content-type')).toBe('application/json');

    client.dispose();
  });

  it('ignores messages from a different source window', async () => {
    const {
      brokerWindow,
      client,
      dispatchBrokerMessage,
    } = createClientHarness();
    mockGenerateId.mockReturnValue('req-2');

    const responsePromise = client.fetch({
      request: {
        url: 'https://en.wikipedia.org/w/api.php?origin=*',
        signal: undefined,
      },
    });
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
    });
    await Promise.resolve();

    dispatchBrokerMessage({
      source: { postMessage: vi.fn() } as unknown as WindowProxy,
      data: {
        protocol: PRIVACY_FETCH_PROTOCOL,
        type: 'response',
        requestId: 'req-2',
        ok: true,
        responseOk: true,
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
    });

    let settled = false;
    void responsePromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    client.dispose();
  });

  it('rejects when the signal aborts after the request starts', async () => {
    const {
      brokerWindow,
      client,
      dispatchBrokerMessage,
    } = createClientHarness();
    mockGenerateId.mockReturnValue('req-3');

    const controller = new AbortController();
    const responsePromise = client.fetch({
      request: {
        url: 'https://en.wikipedia.org/w/api.php?origin=*',
        signal: controller.signal,
      },
    });
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
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    controller.abort();

    await expect(responsePromise).rejects.toMatchObject({
      name: 'AbortError',
      code: 'aborted',
    });
    expect(brokerWindow.postMessage).toHaveBeenLastCalledWith({
      protocol: PRIVACY_FETCH_PROTOCOL,
      type: 'cancel',
      requestId: 'req-3',
    }, '*');

    client.dispose();
  });

  it('rejects on rejected messages', async () => {
    const {
      brokerWindow,
      client,
      dispatchBrokerMessage,
    } = createClientHarness();
    mockGenerateId.mockReturnValue('req-rejected');

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
    });

    const responsePromise = client.fetch({
      request: {
        url: 'https://en.wikipedia.org/w/api.php?origin=*',
        signal: undefined,
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    dispatchBrokerMessage({
      source: brokerWindow,
      data: {
        protocol: PRIVACY_FETCH_PROTOCOL,
        type: 'rejected',
        requestId: 'req-rejected',
        ok: false,
        validationResult: {
          ok: false,
          code: 'invalid_hostname',
          message: 'Unsupported hostname',
        },
      },
    });

    await expect(responsePromise).rejects.toSatisfy((error: unknown) => {
      return isPrivacyFetchError(error)
        && error.code === 'rejected'
        && error.message.includes('rejected');
    });

    client.dispose();
  });

  it('rejects on error messages', async () => {
    const {
      brokerWindow,
      client,
      dispatchBrokerMessage,
    } = createClientHarness();
    mockGenerateId.mockReturnValue('req-error');

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
    });

    const responsePromise = client.fetch({
      request: {
        url: 'https://en.wikipedia.org/w/api.php?origin=*',
        signal: undefined,
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    dispatchBrokerMessage({
      source: brokerWindow,
      data: {
        protocol: PRIVACY_FETCH_PROTOCOL,
        type: 'error',
        requestId: 'req-error',
        ok: false,
        code: 'fetch_failed',
        message: 'Network error',
      },
    });

    await expect(responsePromise).rejects.toSatisfy((error: unknown) => {
      return isPrivacyFetchError(error)
        && error.code === 'fetch_failed'
        && error.message.includes('fetch failed');
    });

    client.dispose();
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const { client } = createClientHarness();
    const controller = new AbortController();
    controller.abort();

    await expect(client.fetch({
      request: {
        url: 'https://en.wikipedia.org/w/api.php?origin=*',
        signal: controller.signal,
      },
    })).rejects.toMatchObject({
      name: 'AbortError',
      code: 'aborted',
    });

    client.dispose();
  });

  it('rejects while waiting for broker readiness when the signal aborts', async () => {
    const { client } = createClientHarness();
    const controller = new AbortController();

    const responsePromise = client.fetch({
      request: {
        url: 'https://en.wikipedia.org/w/api.php?origin=*',
        signal: controller.signal,
      },
    });

    controller.abort();

    await expect(responsePromise).rejects.toMatchObject({
      name: 'AbortError',
      code: 'aborted',
    });

    client.dispose();
  });
});
