import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getDevelopmentMetaCspPrivacyBrokerSyncNotForSecurity } from '@/logic/development-meta-csp/privacy-broker-sync';
import { generateId } from '@/01-models/id';
import { idToRaw, toPrivacyFetchRequestId } from '@/01-models/ids';
import { createPrivacyFetchError } from './errors';
import { normalizePrivacyFetchHeaders } from './request';
import { streamRequestSchema } from './stream-protocol';
import { receivePrivacyStream } from './stream-port';
import { PRIVACY_FETCH_PROTOCOL } from './protocol';
import { privacyFetchBrokerToParentMessageSchema } from './schemas';
import type { PrivacyFetchBrokerClient } from './types';

const source = fs.readFileSync('src/features/privacy-fetch/broker-client.ts', 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
}).outputText;
const clients: PrivacyFetchBrokerClient[] = [];
const channels: MessageChannel[] = [];

class TrackedMessageChannel extends MessageChannel {
  constructor() {
    super();
    channels.push(this);
  }
}

function createModuleLoader() {
  const context = vm.createContext({ window, document, HTMLElement, Headers, MessageChannel: TrackedMessageChannel });
  const hotData: Record<string, unknown> = {};
  const dependencies: Record<string, Record<string, unknown>> = {
    '@/logic/development-meta-csp/privacy-broker-sync': { getDevelopmentMetaCspPrivacyBrokerSyncNotForSecurity },
    '@/01-models/id': { generateId },
    '@/01-models/ids': { idToRaw, toPrivacyFetchRequestId },
    './errors': { createPrivacyFetchError },
    './request': { normalizePrivacyFetchHeaders },
    './stream-protocol': { streamRequestSchema },
    './stream-port': { receivePrivacyStream },
    './protocol': { PRIVACY_FETCH_PROTOCOL },
    './schemas': { privacyFetchBrokerToParentMessageSchema },
  };
  return {
    async evaluate({ hotMode }: { hotMode: 'enabled' | 'disabled' | 'without-data' }) {
      const dispose = vi.fn<(callback: () => void) => void>();
      const callbacks: (() => void)[] = [];
      const module = new vm.SourceTextModule(code, {
        context,
        initializeImportMeta(meta) {
          if (hotMode !== 'disabled') {
            Object.defineProperty(meta, 'hot', {
              value: {
                data: hotMode === 'enabled' ? hotData : undefined,
                dispose: (callback: () => void) => {
                  callbacks.push(callback);
                  dispose(callback);
                },
              },
            });
          }
        },
      });
      await module.link((specifier) => {
        const exports = dependencies[specifier];
        if (exports === undefined) {
          throw new Error(`Unexpected broker import: ${specifier}`);
        }
        return new vm.SyntheticModule(Object.keys(exports), function () {
          for (const [name, value] of Object.entries(exports)) {
            this.setExport(name, value);
          }
        }, { context });
      });
      await module.evaluate();
      const exports = module.namespace as Pick<typeof import('./broker-client'), 'getPrivacyFetchBrokerClient'>;
      return {
        dispose,
        callbacks,
        getClient() {
          const client = exports.getPrivacyFetchBrokerClient();
          clients.push(client);
          return client;
        },
      };
    },
  };
}

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.dispose();
  }
  for (const channel of channels.splice(0)) {
    channel.port1.close();
    channel.port2.close();
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('privacy fetch broker module replacement', () => {
  it('does not create an iframe merely by evaluating a development module', async () => {
    const loader = createModuleLoader();
    const module = await loader.evaluate({ hotMode: 'enabled' });
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
    expect(module.dispose).toHaveBeenCalledTimes(1);
    const client = module.getClient();
    expect(module.getClient()).toBe(client);
    expect(document.querySelectorAll('iframe')).toHaveLength(1);
  });

  it('preserves lazy singleton creation without a hot context', async () => {
    const module = await createModuleLoader().evaluate({ hotMode: 'disabled' });
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
    expect(module.dispose).not.toHaveBeenCalled();
    const client = module.getClient();
    expect(module.getClient()).toBe(client);
    expect(document.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(document.querySelector('iframe')?.referrerPolicy).toBe('no-referrer');
  });

  it('preserves lazy singleton creation when a host provides no hot data', async () => {
    const module = await createModuleLoader().evaluate({ hotMode: 'without-data' });
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
    const client = module.getClient();
    expect(module.getClient()).toBe(client);
    expect(document.querySelectorAll('iframe')).toHaveLength(1);
  });

  it('disposes the old client on re-evaluation even without a dispose notification', async () => {
    const removeListener = vi.spyOn(window, 'removeEventListener');
    const loader = createModuleLoader();
    const first = await loader.evaluate({ hotMode: 'enabled' });
    const client = first.getClient();
    const iframe = document.querySelector('iframe');
    const waiting = client.fetch({ request: { url: 'https://example.invalid/', signal: undefined } });
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'broker_disposed' });

    const second = await loader.evaluate({ hotMode: 'enabled' });
    await rejected;
    expect(iframe?.isConnected).toBe(false);
    expect(removeListener).toHaveBeenCalledWith('message', expect.any(Function));
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
    expect(second.getClient()).not.toBe(client);
    expect(document.querySelectorAll('iframe')).toHaveLength(1);
  });

  it('rejects an in-flight request and removes its abort listener on replacement', async () => {
    const loader = createModuleLoader();
    const first = await loader.evaluate({ hotMode: 'enabled' });
    const client = first.getClient();
    const brokerWindow = document.querySelector('iframe')?.contentWindow;
    if (brokerWindow === undefined || brokerWindow === null) {
      throw new Error('Missing broker window.');
    }
    const postMessage = vi.spyOn(brokerWindow, 'postMessage').mockImplementation(() => {});
    window.dispatchEvent(new MessageEvent('message', {
      source: brokerWindow,
      data: {
        protocol: PRIVACY_FETCH_PROTOCOL,
        type: 'ready',
        capabilities: { responseBody: 'arrayBuffer', transferArrayBuffer: true, headers: 'entries' },
      },
    }));
    const controller = new AbortController();
    const removeAbort = vi.spyOn(controller.signal, 'removeEventListener');
    const waiting = client.fetch({ request: { url: 'https://example.invalid/', signal: controller.signal } });
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'broker_disposed' });
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));

    const second = await loader.evaluate({ hotMode: 'enabled' });
    await rejected;
    expect(removeAbort).toHaveBeenCalledWith('abort', expect.any(Function));
    controller.abort();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(second.getClient()).not.toBe(client);
    expect(document.querySelectorAll('iframe')).toHaveLength(1);
  });

  it('rejects a stream waiting for broker readiness when the module is replaced', async () => {
    const loader = createModuleLoader();
    const first = await loader.evaluate({ hotMode: 'enabled' });
    const waiting = first.getClient().fetchStream({
      request: {
        url: 'https://huggingface.co/owner/model/resolve/main/model.gguf',
      },
    });
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'broker_disposed' });
    const second = await loader.evaluate({ hotMode: 'enabled' });
    await rejected;
    expect(channels).toHaveLength(0);
    expect(typeof second.getClient().fetchStream).toBe('function');
    expect(document.querySelectorAll('iframe')).toHaveLength(1);
  });

  it('disposes an active stream awaiting headers when the module is replaced', async () => {
    const loader = createModuleLoader();
    const first = await loader.evaluate({ hotMode: 'enabled' });
    const client = first.getClient();
    const brokerWindow = document.querySelector('iframe')?.contentWindow;
    if (brokerWindow === undefined || brokerWindow === null) {
      throw new Error('Missing broker window.');
    }
    const postMessage = vi.spyOn(brokerWindow, 'postMessage').mockImplementation(() => {});
    window.dispatchEvent(new MessageEvent('message', {
      source: brokerWindow,
      data: {
        protocol: PRIVACY_FETCH_PROTOCOL,
        type: 'ready',
        capabilities: { responseBody: 'arrayBuffer', transferArrayBuffer: true, headers: 'entries' },
      },
    }));
    const controller = new AbortController();
    const removeAbort = vi.spyOn(controller.signal, 'removeEventListener');
    const waiting = client.fetchStream({
      request: {
        url: 'https://huggingface.co/owner/model/resolve/main/model.gguf',
        signal: controller.signal,
      },
    });
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'broker_disposed' });
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    expect(channels).toHaveLength(1);
    const channel = channels[0];
    if (channel === undefined) {
      throw new Error('Missing stream channel.');
    }
    const close = vi.spyOn(channel.port1, 'close');

    const second = await loader.evaluate({ hotMode: 'enabled' });
    await rejected;
    expect(close).toHaveBeenCalled();
    expect(removeAbort).toHaveBeenCalledWith('abort', expect.any(Function));
    controller.abort();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(second.getClient()).not.toBe(client);
    expect(document.querySelectorAll('iframe')).toHaveLength(1);
  });

  it('keeps one broker across repeated dependency evaluations', async () => {
    const loader = createModuleLoader();
    for (let index = 0; index < 5; index += 1) {
      const module = await loader.evaluate({ hotMode: 'enabled' });
      module.getClient();
      expect(document.querySelectorAll('iframe')).toHaveLength(1);
    }
  });

  it('supports a dispose notification followed by module evaluation', async () => {
    const loader = createModuleLoader();
    const first = await loader.evaluate({ hotMode: 'enabled' });
    first.getClient();
    expect(first.callbacks).toHaveLength(1);
    first.callbacks[0]?.();
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
    const second = await loader.evaluate({ hotMode: 'enabled' });
    const client = second.getClient();
    first.callbacks[0]?.();
    expect(second.getClient()).toBe(client);
    expect(document.querySelectorAll('iframe')).toHaveLength(1);
  });

  it('does not clear a newer singleton when a retired client is disposed again', async () => {
    const module = await createModuleLoader().evaluate({ hotMode: 'disabled' });
    const retired = module.getClient();
    retired.dispose();
    const retained = module.getClient();
    retired.dispose();
    expect(module.getClient()).toBe(retained);
    expect(document.querySelectorAll('iframe')).toHaveLength(1);
  });
});
