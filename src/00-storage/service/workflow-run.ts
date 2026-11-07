import { generateId } from '@/01-models/id';
import { idToRaw, type WorkflowRunId, type WorkflowId } from '@/01-models/ids';
import type { StorageType } from '@/01-models/types';
import type { WorkflowDefinition, WorkflowRunRecord, WorkflowRunEntry } from '@/01-models/workflow';
import { ExperimentalWorkflowRunSchemaDto } from '@/00-storage/00-dto/experimental-workflow.dto';
import { workflowRunToDomain, workflowRunToDto } from '@/00-storage/mapper/workflow';
import { OPFS_TMP_DIR, SYNC_LOCK_KEY } from '@/constants';
import { parseWorkflowJson } from './workflow-json';
import { acquireWorkflowRunLease, type WorkflowRunLease } from './workflow-run-ownership';

export type WorkflowRunSnapshot = { record: WorkflowRunRecord, source: string };
export type WorkflowRunSummary = Pick<WorkflowRunRecord, 'id' | 'workflowId' | 'startedAt' | 'finishedAt' | 'status'> & { name: string };
export type WorkflowRunListing = { items: WorkflowRunSummary[], unreadable: { fileName: string, message: string }[] };
export type WorkflowRunActivity = 'active' | 'recoverable' | 'unverifiable' | 'finished';
export type WorkflowRunStore = {
  list: () => Promise<WorkflowRunListing>,
  load: ({ id }: { id: WorkflowRunId }) => Promise<WorkflowRunSnapshot>,
  create: ({ workflowId, definition }: { workflowId: WorkflowId | undefined, definition: WorkflowDefinition }) => Promise<WorkflowRunSnapshot>,
  finish: ({ previous, status, entries, error, resultsPath, resultError }: {
    previous: WorkflowRunSnapshot, status: Exclude<WorkflowRunRecord['status'], 'running' | 'interrupted'>,
    entries: WorkflowRunEntry[], error: string | undefined, resultsPath: string[] | undefined, resultError: string | undefined,
  }) => Promise<WorkflowRunSnapshot>,
  checkpoint: ({ previous, entries }: { previous: WorkflowRunSnapshot, entries: WorkflowRunEntry[] }) => Promise<WorkflowRunSnapshot>,
  release: ({ id }: { id: WorkflowRunId }) => Promise<void>,
  activity: ({ previous }: { previous: WorkflowRunSnapshot }) => Promise<WorkflowRunActivity>,
  interrupt: ({ previous }: { previous: WorkflowRunSnapshot }) => Promise<WorkflowRunSnapshot>,
  remove: ({ previous }: { previous: WorkflowRunSnapshot }) => Promise<void>,
};
type Access = {
  acquireRun: ({ id }: { id: WorkflowRunId }) => Promise<WorkflowRunLease | undefined>,
  directory: ({ create }: { create: boolean }) => Promise<FileSystemDirectoryHandle | undefined>,
  lock: <T>({ operation }: { operation: () => Promise<T> }) => Promise<T>,
};
const MAX_BYTES = 8 * 1024 * 1024;
const terminalStatuses = { running: false, completed: true, failed: true, cancelled: true, interrupted: true } satisfies Record<WorkflowRunRecord['status'], boolean>;

function hasVerifiableOwner({ record }: { record: WorkflowRunRecord }): boolean {
  switch (record.ownership) {
  case 'web_lock': return true;
  case undefined: return false;
  default: {
    const exhaustive: never = record.ownership;
    throw new Error(String(exhaustive));
  }
  }
}

function fileName({ id }: { id: WorkflowRunId }): string {
  const raw = idToRaw({ id });
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(raw)) {
    throw new Error('Invalid Workflow run ID.');
  }
  return `${raw}.json`;
}

function notFound({ error }: { error: unknown }): boolean {
  return (error instanceof Error || error instanceof DOMException) && error.name === 'NotFoundError';
}

function validate({ record }: { record: WorkflowRunRecord }): void {
  const terminal = terminalStatuses[record.status];
  if (!Number.isSafeInteger(record.startedAt) || record.startedAt < 0 || terminal !== (record.finishedAt !== undefined)
    || (record.finishedAt !== undefined && (!Number.isSafeInteger(record.finishedAt) || record.finishedAt < record.startedAt))) {
    throw new Error('Invalid Workflow run timestamps.');
  }
  if (record.checkpointAt !== undefined && (!Number.isSafeInteger(record.checkpointAt) || record.checkpointAt < record.startedAt
    || (record.finishedAt !== undefined && record.checkpointAt > record.finishedAt))) {
    throw new Error('Invalid Workflow checkpoint timestamp.');
  }
  if (hasVerifiableOwner({ record }) && record.checkpointAt === undefined) {
    throw new Error('Owned Workflow history requires a checkpoint timestamp.');
  }
  if (record.entries.length > 200 || record.entries.some(entry => !Number.isSafeInteger(entry.number) || entry.number < 1 || entry.trace.length > 32
    || entry.trace.some(index => !Number.isSafeInteger(index) || index < 0) || entry.preview.length > 4096 || entry.inputPreview.length > 4096)) {
    throw new Error('Workflow history preview limit exceeded.');
  }
  if (record.resultsPath !== undefined && (record.resultsPath.length !== 3 || record.resultsPath[0] !== OPFS_TMP_DIR
    || record.resultsPath.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\'))
    || !record.resultsPath[2]?.startsWith('workflow-results-'))) {
    throw new Error('Workflow results must belong to a temporary results directory.');
  }
}

function decode({ source, name }: { source: string, name: string }): WorkflowRunSnapshot {
  if (new TextEncoder().encode(source).byteLength > MAX_BYTES) {
    throw new Error('Workflow history record is too large.');
  }
  const value: unknown = JSON.parse(source);
  // Check the recursive definition before running its DTO schema. The preview
  // envelope has a separate size budget and contains no recursive user values.
  if (!value || typeof value !== 'object' || !('definition' in value)) {
    throw new Error('Workflow history definition is missing.');
  }
  parseWorkflowJson({ text: JSON.stringify(value.definition) });
  const record = workflowRunToDomain({ dto: ExperimentalWorkflowRunSchemaDto.parse(value) });
  if (fileName({ id: record.id }) !== name) {
    throw new Error('Workflow run identity does not match its file.');
  }
  validate({ record });
  return { record, source };
}

async function read({ directory, name }: { directory: FileSystemDirectoryHandle, name: string }): Promise<string | undefined> {
  try {
    const file = await (await directory.getFileHandle(name)).getFile();
    if (file.size > MAX_BYTES) {
      throw new Error('Workflow history record is too large.');
    }
    return await file.text();
  } catch (error) {
    if (notFound({ error })) {
      return undefined;
    }
    throw error;
  }
}

function createStore({ access }: { access: Access }): WorkflowRunStore {
  // A deserialized snapshot cannot grant ownership. Only the creating store can
  // checkpoint or finish a run, until it explicitly releases its private lease.
  const owners = new Map<WorkflowRunId, { lease: WorkflowRunLease, state: 'open' | 'closing', pending: Promise<void>, releasing: Promise<void> | undefined }>();
  function release({ id }: { id: WorkflowRunId }): Promise<void> {
    const owner = owners.get(id);
    if (!owner) {
      return Promise.resolve();
    }
    if (!owner.releasing) {
      owner.state = 'closing';
      owner.releasing = owner.pending.then(async () => {
        await owner.lease.release();
        owners.delete(id);
      });
    }
    return owner.releasing;
  }
  const persist = async ({ record, expected, writer }: { record: WorkflowRunRecord, expected: string | undefined, writer: 'owner' | 'exclusive' }): Promise<WorkflowRunSnapshot> => {
    // Encode before waiting for the lock: later edits and progress must not alter this snapshot.
    const source = JSON.stringify(workflowRunToDto({ domain: record }));
    const name = fileName({ id: record.id });
    const snapshot = decode({ source, name });
    const write = () => access.lock({
      operation: async () => {
        const directory = await access.directory({ create: true });
        if (!directory) {
          throw new Error('Workflow history storage is unavailable.');
        }
        if (await read({ directory, name }) !== expected) {
          throw new Error('Workflow history changed or was removed. Reload before updating.');
        }
        const writer = await (await directory.getFileHandle(name, { create: true })).createWritable();
        try {
          await writer.write(source);
          await writer.close();
        } catch (error) {
          await writer.abort(error).catch(() => undefined);
          throw error;
        }
        return snapshot;
      },
    });
    switch (writer) {
    case 'exclusive': return write();
    case 'owner': {
      const owner = owners.get(record.id);
      if (!owner || owner.state !== 'open') {
        throw new Error('This store no longer owns the Workflow run.');
      }
      const pending = owner.pending.then(write);
      owner.pending = pending.then(() => undefined, () => undefined);
      return pending;
    }
    default: {
      const exhaustive: never = writer;
      throw new Error(String(exhaustive));
    }
    }
  };
  function originalRecord({ previous }: { previous: WorkflowRunSnapshot }): WorkflowRunRecord {
    return decode({ source: previous.source, name: fileName({ id: previous.record.id }) }).record;
  }
  function requireRunning({ original }: { original: WorkflowRunRecord }): void {
    switch (original.status) {
    case 'running': return;
    case 'completed': case 'failed': case 'cancelled': case 'interrupted':
      throw new Error('A finished Workflow run cannot be rewritten.');
    default: {
      const exhaustive: never = original.status;
      throw new Error(String(exhaustive));
    }
    }
  }
  return {
    release,
    async activity({ previous }) {
      const original = originalRecord({ previous });
      if (terminalStatuses[original.status]) {
        return 'finished';
      }
      // Legacy records did not hold an execution lock. Absence of a lock is not
      // evidence of abandonment for those records, regardless of their age.
      if (!hasVerifiableOwner({ record: original })) {
        return 'unverifiable';
      }
      const lease = await access.acquireRun({ id: original.id });
      if (!lease) {
        return 'active';
      }
      await lease.release();
      return 'recoverable';
    },
    async interrupt({ previous }) {
      const original = originalRecord({ previous });
      requireRunning({ original });
      if (!hasVerifiableOwner({ record: original })) {
        throw new Error('The owner of this Workflow run cannot be verified.');
      }
      const lease = await access.acquireRun({ id: original.id });
      if (!lease) {
        throw new Error('This Workflow run is active or awaiting a history save in another tab.');
      }
      try {
        // Keep the checkpoint and previews. This time records recovery, not the
        // unknowable crash time. No model, tool, output path, or editor is opened.
        return await persist({
          record: { ...original, status: 'interrupted', finishedAt: Math.max(Date.now(), original.checkpointAt ?? original.startedAt) },
          expected: previous.source,
          writer: 'exclusive',
        });
      } finally {
        await lease.release();
      }
    },
    checkpoint({ previous, entries }) {
      const original = originalRecord({ previous });
      requireRunning({ original });
      return persist({
        record: { ...original, entries, checkpointAt: Math.max(Date.now(), original.checkpointAt ?? original.startedAt) },
        expected: previous.source,
        writer: 'owner',
      });
    },
    async list() {
      const directory = await access.directory({ create: false });
      const listing: WorkflowRunListing = { items: [], unreadable: [] };
      if (!directory) {
        return listing;
      }
      let count = 0;
      for await (const [name, entry] of directory.entries()) {
        if (entry.kind !== 'file' || !/^[A-Za-z0-9_-]{1,64}\.json$/.test(name)) {
          continue;
        }
        if (++count > 2000) {
          throw new Error('Too many Workflow history records. Remove unused history.');
        }
        try {
          const source = await read({ directory, name });
          if (source === undefined) {
            continue;
          }
          const { record } = decode({ source, name });
          listing.items.push({ id: record.id, workflowId: record.workflowId, name: record.definition.name, startedAt: record.startedAt, finishedAt: record.finishedAt, status: record.status });
        } catch (error) {
          listing.unreadable.push({ fileName: name, message: error instanceof Error ? error.message : String(error) });
        }
      }
      listing.items.sort((a, b) => b.startedAt - a.startedAt || idToRaw({ id: a.id }).localeCompare(idToRaw({ id: b.id })));
      return listing;
    },
    async load({ id }) {
      const directory = await access.directory({ create: false });
      const name = fileName({ id });
      const source = directory && await read({ directory, name });
      if (source === undefined) {
        throw new Error('Workflow history was not found.');
      }
      return decode({ source, name });
    },
    async create({ workflowId, definition }) {
      // Freeze the exact input before awaiting even the ownership lock.
      const captured = structuredClone(definition);
      const id = generateId<WorkflowRunId>();
      const lease = await access.acquireRun({ id });
      if (!lease) {
        throw new Error('Workflow run identity is already in use.');
      }
      try {
        const startedAt = Date.now();
        const snapshot = await persist({
          record: {
            id,
            workflowId,
            definition: captured,
            startedAt,
            finishedAt: undefined,
            status: 'running',
            ownership: 'web_lock',
            checkpointAt: startedAt,
            entries: [],
            error: undefined,
            resultsPath: undefined,
            resultError: undefined,
          },
          expected: undefined,
          writer: 'exclusive',
        });
        owners.set(id, { lease, state: 'open', pending: Promise.resolve(), releasing: undefined });
        return snapshot;
      } catch (error) {
        await lease.release();
        throw error;
      }
    },
    finish({ previous, status, entries, error, resultsPath, resultError }) {
      const original = originalRecord({ previous });
      requireRunning({ original });
      const finishedAt = Math.max(Date.now(), original.checkpointAt ?? original.startedAt);
      return persist({
        record: { ...original, status, entries, error, resultsPath, resultError, finishedAt, checkpointAt: finishedAt },
        expected: previous.source,
        writer: 'owner',
      }).then(async snapshot => {
        await release({ id: original.id });
        return snapshot;
      });
    },
    async remove({ previous }) {
      if (!terminalStatuses[originalRecord({ previous }).status]) {
        throw new Error('Mark an abandoned Workflow run as interrupted before deleting its history.');
      }
      const name = fileName({ id: previous.record.id });
      await access.lock({
        operation: async () => {
          const directory = await access.directory({ create: false });
          if (!directory || await read({ directory, name }) !== previous.source) {
            throw new Error('Workflow history changed or was removed. Reload before deleting.');
          }
          // History deletion never follows paths into user Volumes or temporary output folders.
          await directory.removeEntry(name);
        },
      });
    },
  };
}

export function createWorkflowRunStore({ storageType }: { storageType: StorageType }): WorkflowRunStore {
  if (storageType !== 'opfs' || !navigator.locks?.request) {
    throw new Error('Workflow history requires OPFS storage and Web Locks.');
  }
  return createStore({
    access: {
      acquireRun: ({ id }) => acquireWorkflowRunLease({ locks: navigator.locks, id }),
      async directory({ create }) {
        let directory = await navigator.storage.getDirectory();
        for (const name of ['naidan-storage', 'experimental', 'workflows', 'runs']) {
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
      lock: ({ operation }) => navigator.locks.request(SYNC_LOCK_KEY, () => navigator.locks.request('naidan-experimental-workflow-runs', operation)),
    },
  });
}

export const TEST_ONLY = {
  createStore,
};
