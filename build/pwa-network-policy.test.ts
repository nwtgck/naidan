// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNetworkUpdatePolicy } from '../pwa/network-policy';
import { MemoryCacheStorage, TestClients } from './test-support/pwa-worker-platform';
import { NETWORK_UPDATE_PARAMETER } from '../src/logic/pwa/protocol';

const scope = 'https://example.test/app/';
const token = '01234567-1234-1234-1234-0123456789ab';
const onlineUrl = `${scope}?${NETWORK_UPDATE_PARAMETER}=${token}`;
function fixture() {
  const clients = new TestClients();
  const storage = new MemoryCacheStorage();
  const create = (buildId = 'old') => createNetworkUpdatePolicy({ scope, buildId, clients: clients as unknown as Clients, storage: storage.native() });
  const event = ({ url = `${scope}runtime.wasm`, clientId = '', resultingClientId = '', navigation = false, destination = '', method = 'GET', referrer = '' } = {}) => {
    const request = new Request(url, { method, ...(referrer ? { referrer } : {}) });
    Object.defineProperty(request, 'destination', { value: destination });
    if (navigation) Object.defineProperty(request, 'mode', { value: 'navigate' });
    return { request, clientId, resultingClientId } as FetchEvent;
  };
  const add = (id: string, url: string, type: 'window' | 'worker' | 'sharedworker' = 'window') => clients.clients.set(id, { id, url, type });
  return { clients, storage, create, event, add };
}
afterEach(() => vi.restoreAllMocks());

describe('network update routing policy', () => {
  it('does not bypass caches without explicit consent or for malformed markers', async () => {
    const f = fixture(); const policy = f.create();
    f.add('normal', scope);
    expect(await policy.needsNetwork({ event: f.event({ clientId: 'normal' }) })).toBe(false);
    expect(await policy.needsNetwork({ event: f.event({ url: `${scope}?${NETWORK_UPDATE_PARAMETER}=bad` }) })).toBe(false);
    expect(await policy.needsNetwork({ event: f.event({ url: `${scope}image.png?${NETWORK_UPDATE_PARAMETER}=${token}` }) })).toBe(false);
  });

  it('does not repeat storage lookups for a known ordinary window, while a new navigation still opts in', async () => {
    const f = fixture(); f.add('normal', scope); const policy = f.create();
    const metadata = await f.storage.open(`naidan-pwa-update-coordination-v1:${scope}`);
    const match = vi.spyOn(metadata, 'match');
    await policy.needsNetwork({ event: f.event({ clientId: 'normal' }) });
    const initial = match.mock.calls.length;
    await policy.needsNetwork({ event: f.event({ clientId: 'normal' }) });
    expect(match).toHaveBeenCalledTimes(initial);
    await policy.needsNetwork({ event: f.event({ url: onlineUrl, clientId: 'normal', resultingClientId: 'new-document', navigation: true, destination: 'document' }) });
    expect(await policy.needsNetwork({ event: f.event({ clientId: 'new-document' }) })).toBe(true);
  });

  it('leaves cross-origin, outside-scope and non-GET requests alone', async () => {
    const f = fixture(); const policy = f.create(); f.add('online', onlineUrl);
    for (const url of ['https://models.example/model.gguf', 'https://example.test/elsewhere/runtime.wasm']) {
      expect(await policy.needsNetwork({ event: f.event({ clientId: 'online', url }) })).toBe(false);
    }
    expect(await policy.needsNetwork({ event: f.event({ clientId: 'online', method: 'POST' }) })).toBe(false);
  });

  it('treats an opted-in page document probe as network-only without changing the initiating page', async () => {
    const f = fixture(); const policy = f.create(); f.add('normal', scope);
    expect(await policy.needsNetwork({ event: f.event({ clientId: 'normal', url: onlineUrl }) })).toBe(true);
    expect(await policy.needsNetwork({ event: f.event({ clientId: 'normal' }) })).toBe(false);
  });

  it('remembers the resulting document before Clients.get can find it', async () => {
    const f = fixture(); const policy = f.create();
    expect(await policy.needsNetwork({ event: f.event({ url: onlineUrl, resultingClientId: 'reserved', navigation: true, destination: 'document' }) })).toBe(true);
    expect(await policy.needsNetwork({ event: f.event({ clientId: 'reserved' }) })).toBe(true);
  });

  it('does not retain a stale missing-row lookup across worker versions', async () => {
    const f = fixture(); const a = f.create(); const b = f.create();
    expect(await a.needsNetwork({ event: f.event({ clientId: 'reserved' }) })).toBe(false);
    await b.needsNetwork({ event: f.event({ url: onlineUrl, resultingClientId: 'reserved', navigation: true, destination: 'document' }) });
    expect(await a.needsNetwork({ event: f.event({ clientId: 'reserved' }) })).toBe(true);
  });

  it('reads updated root identity across worker lifetimes while retaining child links', async () => {
    const f = fixture(); f.add('root', onlineUrl);
    const old = f.create();
    await old.needsNetwork({ event: f.event({ clientId: 'root', resultingClientId: 'child', destination: 'worker' }) });
    f.add('child', `${scope}worker.js`, 'worker');
    const current = f.create('new');
    expect(await current.needsNetwork({ event: f.event({ clientId: 'child' }) })).toBe(true);
    await old.bindPage({ clientId: 'root', pageBuildId: 'new', complete: false });
    expect(await current.needsNetwork({ event: f.event({ clientId: 'child' }) })).toBe(false);
    expect(await old.needsNetwork({ event: f.event({ clientId: 'child' }) })).toBe(true);
  });

  it('uses live opted-in windows for unattributed blob workers, but not ordinary windows', async () => {
    const f = fixture(); const policy = f.create(); f.add('root', onlineUrl);
    f.add('other-tab', scope); f.add('blob', 'blob:https://example.test/worker-uuid', 'worker');
    expect(await policy.needsNetwork({ event: f.event({ clientId: 'blob' }) })).toBe(true);
    expect(await policy.needsNetwork({ event: f.event({ clientId: 'other-tab' }) })).toBe(false);
    f.clients.clients.delete('root');
    expect(await policy.needsNetwork({ event: f.event({ clientId: 'blob' }) })).toBe(false);
  });

  it('requires a matching build and the actual opted-in window before completing online mode', async () => {
    const f = fixture(); const policy = f.create('new'); f.add('root', onlineUrl); f.add('normal', scope);
    expect(await policy.bindPage({ clientId: 'normal', pageBuildId: 'new', complete: true })).toBe(false);
    expect(await policy.bindPage({ clientId: 'root', pageBuildId: 'old', complete: true })).toBe(false);
    expect(await policy.bindPage({ clientId: 'root', pageBuildId: 'new', complete: true })).toBe(true);
    expect(await policy.needsNetwork({ event: f.event({ clientId: 'root' }) })).toBe(false);
  });

  it('does not inherit online mode from a referrer when navigating back to the prepared canonical page', async () => {
    const f = fixture(); f.add('root', onlineUrl); const policy = f.create();
    expect(await policy.needsNetwork({ event: f.event({ url: scope, referrer: onlineUrl, navigation: true, destination: 'document' }) })).toBe(false);
    expect(await policy.needsNetwork({ event: f.event({ referrer: onlineUrl }) })).toBe(true);
  });

  it('keeps ordinary offline caching and online routing usable when coordination storage is denied', async () => {
    const f = fixture(); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(f.storage, 'open').mockRejectedValue(new DOMException('storage unavailable', 'SecurityError'));
    f.add('normal', scope); f.add('root', onlineUrl);
    const policy = f.create();
    expect(await policy.needsNetwork({ event: f.event({ clientId: 'normal' }) })).toBe(false);
    expect(await policy.needsNetwork({ event: f.event({ clientId: 'root', resultingClientId: 'child' }) })).toBe(true);
    expect(await policy.needsNetwork({ event: f.event({ clientId: 'child' }) })).toBe(true);
    expect(await policy.bindPage({ clientId: 'root', pageBuildId: 'old', complete: true })).toBe(true);
    expect(await policy.needsNetwork({ event: f.event({ clientId: 'child' }) })).toBe(false);
    await expect(policy.collectClosedClients()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('recovers from a corrupted bookkeeping row without breaking ordinary cached requests', async () => {
    const f = fixture(); vi.spyOn(console, 'warn').mockImplementation(() => {});
    const metadata = await f.storage.open(`naidan-pwa-update-coordination-v1:${scope}`);
    await metadata.put(`${scope}.pwa-client/normal`, new Response('{broken'));
    f.add('normal', scope);
    expect(await f.create().needsNetwork({ event: f.event({ clientId: 'normal' }) })).toBe(false);
  });

  it('collects only dead bookkeeping, preserving user caches and live child roots', async () => {
    const f = fixture(); const policy = f.create(); f.add('root', onlineUrl);
    await policy.needsNetwork({ event: f.event({ clientId: 'root', resultingClientId: 'child' }) });
    f.add('child', `${scope}worker.js`, 'worker'); f.clients.clients.delete('root');
    const user = await f.storage.open('models'); await user.put(`${scope}model`, new Response('keep'));
    const metadata = await f.storage.open(`naidan-pwa-update-coordination-v1:${scope}`);
    await metadata.put(`${scope}.pwa-client/closed`, new Response(JSON.stringify({ rootId: 'closed' })));
    await policy.collectClosedClients();
    expect(await metadata.match(`${scope}.pwa-client/closed`)).toBeUndefined();
    expect(await metadata.match(`${scope}.pwa-client/root`)).toBeDefined();
    expect(await metadata.match(`${scope}.pwa-client/child`)).toBeDefined();
    expect(await (await user.match(`${scope}model`))?.text()).toBe('keep');
  });
});
