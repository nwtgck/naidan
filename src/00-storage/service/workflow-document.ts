import { generateId } from '@/01-models/id';
import { idToRaw, toWorkflowId, type WorkflowId } from '@/01-models/ids';
import type { StorageType } from '@/01-models/types';
import type { WorkflowDefinition, WorkflowDocument } from '@/01-models/workflow';
import { ExperimentalWorkflowSchemaDto } from '@/00-storage/00-dto/experimental-workflow.dto';
import { workflowDocumentToDomain, workflowDocumentToDto } from '@/00-storage/mapper/workflow';
import { parseWorkflowJson, WORKFLOW_DOCUMENT_MAX_BYTES } from './workflow-json';
import { SYNC_LOCK_KEY } from '@/constants';

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

function fileName({ id }: { id: WorkflowId }): string {
  const raw = idToRaw({ id });
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(raw)) {
    throw new Error('Invalid Workflow document ID.');
  }
  return `${raw}.json`;
}

function notFound({ error }: { error: unknown }): boolean {
  return (error instanceof Error || error instanceof DOMException) && error.name === 'NotFoundError';
}

async function read({ directory, name }: { directory: FileSystemDirectoryHandle, name: string }): Promise<string | undefined> {
  try {
    const file = await (await directory.getFileHandle(name)).getFile();
    if (file.size > WORKFLOW_DOCUMENT_MAX_BYTES) {
      throw new Error('Workflow document is too large to load.');
    }
    return await file.text();
  } catch (error) {
    if (notFound({ error })) {
      return undefined;
    }
    throw error;
  }
}

function decode({ source, name }: { source: string, name: string }): WorkflowSnapshot {
  const dto = ExperimentalWorkflowSchemaDto.parse(parseWorkflowJson({ text: source }));
  if (fileName({ id: toWorkflowId({ raw: dto.id }) }) !== name) {
    throw new Error('Workflow document identity does not match its file.');
  }
  return { document: workflowDocumentToDomain({ dto }), source };
}

function createStore({ access }: { access: Access }): WorkflowDocumentStore {
  return {
    async list() {
      const directory = await access.directory({ create: false });
      const result: WorkflowDocumentListing = { items: [], unreadable: [] };
      if (!directory) {
        return result;
      }
      let count = 0;
      for await (const [name, entry] of directory.entries()) {
        if (entry.kind !== 'file' || !/^[A-Za-z0-9_-]{1,64}\.json$/.test(name)) {
          continue;
        }
        if (++count > 2000) {
          throw new Error('Too many Workflow documents. Export or remove unused documents.');
        }
        try {
          const source = await read({ directory, name });
          if (source === undefined) {
            continue;
          }
          const { document } = decode({ source, name });
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
      const name = fileName({ id });
      const source = directory && await read({ directory, name });
      if (source === undefined) {
        throw new Error('Workflow document was not found.');
      }
      return decode({ source, name });
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
      const dto = ExperimentalWorkflowSchemaDto.parse(workflowDocumentToDto({ domain: document }));
      const source = JSON.stringify(dto);
      parseWorkflowJson({ text: source });
      const expected = previous?.source;
      const name = fileName({ id: document.id });
      return access.lock({
        operation: async () => {
          const directory = await access.directory({ create: true });
          if (!directory) {
            throw new Error('Workflow storage is unavailable.');
          }
          const current = await read({ directory, name });
          if (current !== expected) {
            throw new Error('Workflow changed in another editor. Reload or save a copy.');
          }
          // Decode before overwrite even when the raw comparison matched.
          if (current !== undefined) {
            const stored = decode({ source: current, name }).document;
            if (stored.createdAt !== document.createdAt || stored.kind !== kind) {
              throw new Error('Workflow identity cannot be edited.');
            }
          }
          const handle = await directory.getFileHandle(name, { create: true });
          const writer = await handle.createWritable();
          try {
            await writer.write(source);
            await writer.close();
          } catch (error) {
            await writer.abort(error).catch(() => undefined);
            throw error;
          }
          return decode({ source, name });
        },
      });
    },
    async remove({ previous }) {
      const name = fileName({ id: previous.document.id });
      const expected = previous.source;
      await access.lock({
        operation: async () => {
          const directory = await access.directory({ create: false });
          if (!directory || await read({ directory, name }) !== expected) {
            throw new Error('Workflow changed or was removed. Reload before deleting.');
          }
          await directory.removeEntry(name);
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
        for (const name of ['naidan-storage', 'experimental', 'workflows', 'documents']) {
          try {
            directory = await directory.getDirectoryHandle(name, { create });
          } catch (error) {
            if (!create && notFound({ error })) {
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
