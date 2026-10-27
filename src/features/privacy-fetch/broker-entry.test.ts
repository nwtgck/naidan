import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRIVACY_FETCH_PROTOCOL } from './protocol';
import type { servePrivacyStream } from './stream-port';

const { serveStream } = vi.hoisted(() => ({ serveStream: vi.fn<typeof servePrivacyStream>() }));
vi.mock('./stream-port', () => ({ servePrivacyStream: serveStream }));

let entry: typeof import('./broker-entry');

beforeEach(async () => {
  vi.resetModules();
  entry = await import('./broker-entry');
  // Exercise the actual entry listener synchronously without retaining a
  // module-side listener across jsdom test cases.
  window.removeEventListener('message', entry.TEST_ONLY.handleMessage);
  serveStream.mockReset();
});

afterEach(() => {
  document.head.querySelectorAll('[data-naidan-developer-csp]').forEach(element => element.remove());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function dispatch({ data, source, ports }: { data: unknown, source: WindowProxy, ports: MessagePort[] }) {
  entry.TEST_ONLY.handleMessage.call(window, new MessageEvent('message', { data, source, ports }));
}

function sync({ policies }: { policies: string[] }) {
  return { protocol: PRIVACY_FETCH_PROTOCOL, type: 'development-meta-csp-sync', sessionId: 'one', syncId: 'a', policies };
}

describe('privacy broker entry development synchronization', () => {
  it('validates source and schema before adding any native meta or acknowledging', () => {
    using post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => undefined);
    dispatch({ data: sync({ policies: ['A'] }), source: {} as WindowProxy, ports: [] });
    dispatch({ data: { ...sync({ policies: ['A'] }), policies: [1] }, source: window.parent, ports: [] });
    dispatch({ data: { ...sync({ policies: ['A'] }), extra: true }, source: window.parent, ports: [] });
    expect(document.head.querySelector('[data-naidan-developer-csp]')).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('adds the complete snapshot before the next buffered fetch starts without awaiting ACK', async () => {
    const events: string[] = [];
    using post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {
      events.push('ack');
    });
    const response = new Response('body');
    Object.defineProperty(response, 'url', { value: 'https://huggingface.co/api/models/owner/model' });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      events.push('fetch');
      expect([...document.head.querySelectorAll<HTMLMetaElement>('[data-naidan-developer-csp]')].map(meta => meta.content)).toEqual(['A', 'B']);
      return response;
    });
    vi.stubGlobal('fetch', fetchMock);
    dispatch({ data: sync({ policies: ['A', 'B'] }), source: window.parent, ports: [] });
    expect(post).toHaveBeenCalledWith({ protocol: PRIVACY_FETCH_PROTOCOL, type: 'development-meta-csp-result', sessionId: 'one', syncId: 'a', confirmedPolicyCount: 2, outcome: 'added' }, '*', []);
    dispatch({ data: { protocol: PRIVACY_FETCH_PROTOCOL, type: 'request', requestId: 'request', url: 'https://huggingface.co/api/models/owner/model' }, source: window.parent, ports: [] });
    expect(events).toEqual(['ack', 'fetch']);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  });

  it('keeps synchronous native ordering for the unchanged stream-request route', () => {
    using post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => undefined);
    using channel = {
      value: new MessageChannel(),
      [Symbol.dispose]() {
        this.value.port1.close();
        this.value.port2.close();
      },
    };
    serveStream.mockImplementation(() => {
      expect([...document.head.querySelectorAll<HTMLMetaElement>('[data-naidan-developer-csp]')].map(meta => meta.content)).toEqual(['A']);
    });
    dispatch({ data: sync({ policies: ['A'] }), source: window.parent, ports: [] });
    dispatch({ data: { protocol: PRIVACY_FETCH_PROTOCOL, type: 'stream-request', url: 'https://huggingface.co/api/models/owner/model' }, source: window.parent, ports: [channel.value.port2] });
    expect(post).toHaveBeenCalledOnce();
    expect(serveStream).toHaveBeenCalledOnce();
    const served = serveStream.mock.calls[0]?.[0];
    expect(served?.port).toBe(channel.value.port2);
    expect(served?.request).toEqual({ url: 'https://huggingface.co/api/models/owner/model' });
  });

  it('does not block a later normal request when confirmation postMessage fails', async () => {
    using post = vi.spyOn(window.parent, 'postMessage').mockImplementationOnce(() => {
      throw new Error('ACK unavailable');
    }).mockImplementation(() => undefined);
    const response = new Response('body');
    Object.defineProperty(response, 'url', { value: 'https://huggingface.co/api/models/owner/model' });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    expect(() => dispatch({ data: sync({ policies: ['A'] }), source: window.parent, ports: [] })).not.toThrow();
    dispatch({ data: { protocol: PRIVACY_FETCH_PROTOCOL, type: 'request', requestId: 'request', url: 'https://huggingface.co/api/models/owner/model' }, source: window.parent, ports: [] });
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  });
});
