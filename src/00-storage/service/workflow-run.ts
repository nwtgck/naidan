import { opfsFormat } from '@/00-format/01-layout/layout';
import { generateId } from '@/01-models/id';
import { idToRaw, type WorkflowRunId, type WorkflowId } from '@/01-models/ids';
import type { StorageType } from '@/01-models/types';
import type { WorkflowDefinition, WorkflowRunRecord, WorkflowRunEntry } from '@/01-models/workflow';
import { SYNC_LOCK_KEY } from '@/constants';
import { workflowFileNotFound, workflowFileReader } from './workflow-files';
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
    const prepared = opfsFormat.storage.experimental.workflows.runs.prepareWrite({ record });
    const write = () => access.lock({
      operation: async () => {
        const directory = await access.directory({ create: true });
        if (!directory) {
          throw new Error('Workflow history storage is unavailable.');
        }
        if (await prepared.target.readSource({ readFile: workflowFileReader({ directory }) }) !== expected) {
          throw new Error('Workflow history changed or was removed. Reload before updating.');
        }
        return prepared.write({
          writeText: async ({ file, text }) => {
            const writer = await (await directory.getFileHandle(file.name, { create: true })).createWritable();
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
    return opfsFormat.storage.experimental.workflows.runs.file({ id: previous.record.id }).decode({ source: previous.source }).record;
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
      const readFile = workflowFileReader({ directory });
      for await (const [name, entry] of directory.entries()) {
        const target = opfsFormat.storage.experimental.workflows.runs.listedFile({ name });
        if (entry.kind !== 'file' || !target) {
          continue;
        }
        if (++count > 2000) {
          throw new Error('Too many Workflow history records. Remove unused history.');
        }
        try {
          const snapshot = await target.read({ readFile });
          if (!snapshot) {
            continue;
          }
          const { record } = snapshot;
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
      const target = opfsFormat.storage.experimental.workflows.runs.file({ id });
      const snapshot = directory && await target.read({ readFile: workflowFileReader({ directory }) });
      if (!snapshot) {
        throw new Error('Workflow history was not found.');
      }
      return snapshot;
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
      const target = opfsFormat.storage.experimental.workflows.runs.file({ id: previous.record.id });
      await access.lock({
        operation: async () => {
          const directory = await access.directory({ create: false });
          if (!directory || await target.readSource({ readFile: workflowFileReader({ directory }) }) !== previous.source) {
            throw new Error('Workflow history changed or was removed. Reload before deleting.');
          }
          // History deletion never follows paths into user Volumes or temporary output folders.
          await directory.removeEntry(target.file.name);
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
        for (const name of opfsFormat.storage.experimental.workflows.runs.path) {
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
      lock: ({ operation }) => navigator.locks.request(SYNC_LOCK_KEY, () => navigator.locks.request('naidan-experimental-workflow-runs', operation)),
    },
  });
}

export const TEST_ONLY = {
  createStore,
};
