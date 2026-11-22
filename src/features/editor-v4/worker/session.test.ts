import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEditorSearchWorker } from './impl';
import { createEditorSearchSession, EditorSearchTimeout } from './session';
import type { EditorSearchRequest, EditorSearchClient } from './types';

const createClient = vi.hoisted(() => vi.fn<() => Promise<EditorSearchClient>>());
vi.mock('@/features/editor-v4/worker/client', () => ({ createEditorSearchClient: createClient }));

afterEach(() => {
  createClient.mockReset();
  vi.useRealTimers();
});

const request = {
  options: { query: 'beta', mode: 'literal', caseSensitivity: 'case-sensitive' },
  target: { kind: 'index', index: 0 },
  visible: { start: 0, end: 80 },
} satisfies Omit<EditorSearchRequest, 'version'>;

function expectCurrent(): boolean {
  return true;
}

describe('EditorV4 search session', () => {
  it('synchronizes a snapshot once and sends later edits as changes', async () => {
    const worker = createEditorSearchWorker({ runtime: 'worker' });
    const client = { ...worker, setDocument: vi.fn(worker.setDocument), applyChanges: vi.fn(worker.applyChanges), dispose: vi.fn(async () => {}) };
    createClient.mockResolvedValue(client);
    const session = createEditorSearchSession();
    using _release = {
      [Symbol.dispose]() {
        session.close();
      },
    };

    await expect(session.search({ snapshot: { text: 'alpha', version: 0 }, request: { ...request, version: 0 }, isCurrent: expectCurrent })).resolves.toMatchObject({ count: 0 });
    const change = { baseVersion: 0, version: 1, edits: [{ start: 0, end: 5, text: 'beta' }] };
    session.record({ change });
    await expect(session.search({ snapshot: { text: 'beta', version: 1 }, request: { ...request, version: 1 }, isCurrent: expectCurrent })).resolves.toMatchObject({ count: 1 });
    expect(client.setDocument).toHaveBeenCalledExactlyOnceWith({ snapshot: { text: 'alpha', version: 0 } });
    expect(client.applyChanges).toHaveBeenCalledExactlyOnceWith({ changes: change });
  });

  it('disposes a stalled worker and resynchronizes a query that is already queued', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const worker = createEditorSearchWorker({ runtime: 'worker' });
    const client = { ...worker, search: vi.fn(worker.search), setDocument: vi.fn(worker.setDocument), dispose: vi.fn(async () => {}) };
    const waiting = new Promise<never>(() => {});
    client.search.mockReturnValueOnce(waiting);
    createClient.mockResolvedValue(client);
    const session = createEditorSearchSession();
    using _release = {
      [Symbol.dispose]() {
        session.close();
      },
    };
    const snapshot = { text: 'beta', version: 0 };
    const search = { ...request, version: 0 };
    const rejection = expect(session.search({ snapshot, request: search, isCurrent: expectCurrent })).rejects.toBeInstanceOf(EditorSearchTimeout);
    await vi.advanceTimersByTimeAsync(0);
    const next = session.search({ snapshot, request: search, isCurrent: expectCurrent });
    await vi.advanceTimersByTimeAsync(1500);
    await rejection;
    expect(client.dispose).toHaveBeenCalledTimes(1);

    await expect(next).resolves.toMatchObject({ count: 1 });
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(client.setDocument).toHaveBeenCalledTimes(2);
  });
});
