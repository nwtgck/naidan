import { opfsFormat } from '@/00-format/01-layout/layout';
import { generateId } from '@/01-models/id';
import { idToRaw, type WorkflowId } from '@/01-models/ids';
import type { StorageType } from '@/01-models/types';
import type { WorkflowDefinition, WorkflowDocument } from '@/01-models/workflow';
import { SYNC_LOCK_KEY } from '@/constants';
import { workflowFileNotFound, workflowFileReader } from './workflow-files';

export type WorkflowSnapshot = { document: WorkflowDocument, source: string };
export type WorkflowDocumentSummary = Pick<WorkflowDocument, 'id' | 'kind' | 'createdAt' | 'updatedAt'> & { name: string };
export type WorkflowDocumentListing = { items: WorkflowDocumentSummary[], unreadable: { fileName: string, message: string }[] };
export type WorkflowDocumentStore = {
  list: () => Promise<WorkflowDocumentListing>,
  load: ({ id }: { id: WorkflowId }) => Promise<WorkflowSnapshot>,
  save: ({ previous, definition, kind }: { previous: WorkflowSnapshot | undefined, definition: WorkflowDefinition, kind: WorkflowDocument['kind'] }) => Promise<WorkflowSnapshot>,
  remove: ({ previous }: { previous: WorkflowSnapshot }) => Promise<void>,
};

type Access = {
  directory: ({ create }: { create: boolean }) => Promise<FileSystemDirectoryHandle | undefined>,
  lock: <T>({ operation }: { operation: () => Promise<T> }) => Promise<T>,
};

function createStore({ access }: { access: Access }): WorkflowDocumentStore {
  return {
    async list() {
      const directory = await access.directory({ create: false });
      const result: WorkflowDocumentListing = { items: [], unreadable: [] };
      if (!directory) {
        return result;
      }
      let count = 0;
      const readFile = workflowFileReader({ directory });
      for await (const [name, entry] of directory.entries()) {
        const target = opfsFormat.storage.experimental.workflows.documents.listedFile({ name });
        if (entry.kind !== 'file' || !target) {
          continue;
        }
        if (++count > 2000) {
          throw new Error('Too many Workflow documents. Export or remove unused documents.');
        }
        try {
          const snapshot = await target.read({ readFile });
          if (!snapshot) {
            continue;
          }
          const { document } = snapshot;
          result.items.push({ id: document.id, kind: document.kind, createdAt: document.createdAt, updatedAt: document.updatedAt, name: document.definition.name });
        } catch (error) {
          result.unreadable.push({ fileName: name, message: error instanceof Error ? error.message : String(error) });
        }
      }
      result.items.sort((a, b) => b.updatedAt - a.updatedAt || idToRaw({ id: a.id }).localeCompare(idToRaw({ id: b.id })));
      return result;
    },
    async load({ id }) {
      const directory = await access.directory({ create: false });
      const target = opfsFormat.storage.experimental.workflows.documents.file({ id });
      const snapshot = directory && await target.read({ readFile: workflowFileReader({ directory }) });
      if (!snapshot) {
        throw new Error('Workflow document was not found.');
      }
      return snapshot;
    },
    async save({ previous, definition, kind }) {
      // Snapshot before waiting for a lock: later form changes are not part of this save.
      const now = Date.now();
      const document: WorkflowDocument = {
        id: previous?.document.id ?? generateId<WorkflowId>(),
        kind,
        createdAt: previous?.document.createdAt ?? now,
        updatedAt: now,
        definition,
      };
      const prepared = opfsFormat.storage.experimental.workflows.documents.prepareWrite({ document });
      const expected = previous?.source;
      return access.lock({
        operation: async () => {
          const directory = await access.directory({ create: true });
          if (!directory) {
            throw new Error('Workflow storage is unavailable.');
          }
          const current = await prepared.target.readSource({ readFile: workflowFileReader({ directory }) });
          if (current !== expected) {
            throw new Error('Workflow changed in another editor. Reload or save a copy.');
          }
          // Decode before overwrite even when the raw comparison matched.
          if (current !== undefined) {
            const stored = prepared.target.decode({ source: current }).document;
            if (stored.createdAt !== document.createdAt || stored.kind !== kind) {
              throw new Error('Workflow identity cannot be edited.');
            }
          }
          return prepared.write({
            writeText: async ({ file, text }) => {
              const handle = await directory.getFileHandle(file.name, { create: true });
              const writer = await handle.createWritable();
              try {
                await writer.write(text);
                await writer.close();
              } catch (error) {
                await writer.abort(error).catch(() => undefined);
                throw error;
              }
            },
          });
        },
      });
    },
    async remove({ previous }) {
      const target = opfsFormat.storage.experimental.workflows.documents.file({ id: previous.document.id });
      const expected = previous.source;
      await access.lock({
        operation: async () => {
          const directory = await access.directory({ create: false });
          if (!directory || await target.readSource({ readFile: workflowFileReader({ directory }) }) !== expected) {
            throw new Error('Workflow changed or was removed. Reload before deleting.');
          }
          await directory.removeEntry(target.file.name);
        },
      });
    },
  };
}

export function createWorkflowDocumentStore({ storageType }: { storageType: StorageType }): WorkflowDocumentStore {
  switch (storageType) {
  case 'opfs': break;
  case 'local': case 'memory': throw new Error('Workflow saving requires OPFS storage.');
  default: {
    const exhaustive: never = storageType;
    throw new Error(`Unsupported storage type: ${exhaustive}`);
  }
  }
  if (!navigator.locks?.request) {
    throw new Error('Workflow saving requires Web Locks.');
  }
  return createStore({
    access: {
      async directory({ create }) {
        let directory = await navigator.storage.getDirectory();
        for (const name of opfsFormat.storage.experimental.workflows.documents.path) {
          try {
            directory = await directory.getDirectoryHandle(name, { create });
          } catch (error) {
            if (!create && workflowFileNotFound({ error })) {
              return undefined;
            }
            throw error;
          }
        }
        return directory;
      },
      lock: ({ operation }) => navigator.locks.request(SYNC_LOCK_KEY, () => navigator.locks.request('naidan-experimental-workflows', operation)),
    },
  });
}

export const TEST_ONLY = {
  createStore,
};
