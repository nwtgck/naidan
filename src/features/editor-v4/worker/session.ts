import { createEditorSearchClient } from '@/features/editor-v4/worker/client';
import type {
  EditorDocumentChanges,
  EditorDocumentSnapshot,
  EditorReplaceRequest,
  EditorSearchClient,
  EditorSearchRequest,
} from './types';

const SEARCH_TIMEOUT_MS = 1500;
const MAX_PENDING_CHANGES = 128;

export class EditorSearchTimeout extends Error {}

async function runWithTimeout<T>({ operation }: { operation: Promise<T> }): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new EditorSearchTimeout('Editor search timed out')), SEARCH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createEditorSearchSession() {
  let generation = 0;
  let clientPromise: Promise<EditorSearchClient> | undefined;
  let workerVersion: number | undefined;
  let pendingChanges: EditorDocumentChanges[] = [];
  let queue = Promise.resolve();

  function disconnect(): void {
    const previous = clientPromise;
    clientPromise = undefined;
    workerVersion = undefined;
    pendingChanges = [];
    if (previous !== undefined) {
      void previous.then(client => client.dispose()).catch(() => {});
    }
  }

  function close(): void {
    generation++;
    disconnect();
    queue = Promise.resolve();
  }

  function record({ change }: { change: EditorDocumentChanges }): void {
    if (clientPromise === undefined) {
      return;
    }
    if (pendingChanges.length === MAX_PENDING_CHANGES) {
      pendingChanges = [];
    }
    pendingChanges.push(change);
  }

  async function synchronize({
    client, snapshot, connection,
  }: { client: EditorSearchClient, snapshot: EditorDocumentSnapshot, connection: Promise<EditorSearchClient> }): Promise<void> {
    if (workerVersion === snapshot.version) {
      return;
    }
    const changes: EditorDocumentChanges[] = [];
    let nextVersion = workerVersion;
    for (const change of pendingChanges) {
      if (change.baseVersion === nextVersion && change.version <= snapshot.version) {
        changes.push(change);
        nextVersion = change.version;
      }
    }
    if (nextVersion === snapshot.version) {
      for (const change of changes) {
        if (connection !== clientPromise) {
          return;
        }
        await client.applyChanges({ changes: change });
      }
    } else {
      await client.setDocument({ snapshot });
    }
    if (connection === clientPromise) {
      workerVersion = snapshot.version;
      pendingChanges = pendingChanges.filter(change => change.version > snapshot.version);
    }
  }

  function schedule<T>({
    snapshot, run, isCurrent,
  }: {
    snapshot: EditorDocumentSnapshot,
    run: ({ client }: { client: EditorSearchClient }) => Promise<T>,
    isCurrent: () => boolean,
  }): Promise<T | undefined> {
    const startedIn = generation;
    const result = queue.then(async () => {
      if (startedIn !== generation || !isCurrent()) {
        return undefined;
      }
      const connection = clientPromise ??= createEditorSearchClient();
      try {
        const client = await connection;
        if (connection !== clientPromise || !isCurrent()) {
          return undefined;
        }
        return await runWithTimeout({
          operation: (async () => {
            await synchronize({ client, snapshot, connection });
            if (connection !== clientPromise || !isCurrent()) {
              return undefined;
            }
            return run({ client });
          })(),
        });
      } catch (error) {
        if (connection === clientPromise) {
          // A queued, newer query should get a fresh worker rather than be canceled with this one.
          disconnect();
        }
        throw error;
      }
    });
    queue = result.then(() => {}, () => {});
    return result;
  }

  return {
    record,
    close,
    search({
      snapshot, request, isCurrent,
    }: { snapshot: EditorDocumentSnapshot, request: EditorSearchRequest, isCurrent: () => boolean }) {
      return schedule({ snapshot, isCurrent, run: ({ client }) => client.search({ request }) });
    },
    replace({
      snapshot, request, isCurrent,
    }: { snapshot: EditorDocumentSnapshot, request: EditorReplaceRequest, isCurrent: () => boolean }) {
      return schedule({ snapshot, isCurrent, run: ({ client }) => client.replace({ request }) });
    },
  };
}

export const TEST_ONLY = {
};
