import { isLegacyImageGenerationRun, legacyRunToOperation } from '@/00-format/image-generation-operation';
import { opfsFormat } from '@/00-format/01-layout/layout';
import { validateImageGenerationId } from '@/00-format/image-generation-record';
import type { ImageGenerationOperation, ImageGenerationReadResult } from '@/01-models/image-generation';
import { idToRaw, toImageGenerationRunId, type ImageGenerationOperationId, type ImageGenerationRunId, type ImageGenerationSessionId } from '@/01-models/ids';
import { withImageGenerationStore, type ImageGenerationStoreAccess } from './context';
import { imageGenerationIo } from './files';
import { imageGenerationSessionDirectory, imageGenerationRunTable, imageGenerationSessionTable } from './tables';

export function imageGenerationOperationTable({ directory, sessionId, create }: {
  directory: FileSystemDirectoryHandle, sessionId: ImageGenerationSessionId, create: boolean,
}) {
  const session = opfsFormat.storage.experimental.imageGeneration.sessions.root({ rawId: idToRaw({ id: sessionId }) });
  return session.operations.open({ io: imageGenerationIo({ directory, path: session.path }), create });
}

/** Parent last is the acceptance marker. No inference begins until this write
 * succeeds. A lost acknowledgement retries identical IDs and membership. */
export async function saveImageGenerationOperation({ store, operation }: { store: ImageGenerationStoreAccess, operation: ImageGenerationOperation }): Promise<void> {
  const definition = opfsFormat.storage.experimental.imageGeneration.sessions.root({ rawId: idToRaw({ id: operation.sessionId }) });
  const prepared = definition.operations.prepareWrite({ value: operation });
  const record = prepared.snapshot.value;
  await withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await imageGenerationSessionDirectory({ directory, sessionId: record.sessionId });
      if (!session) {
        throw new Error('The operation session no longer exists.');
      }
      const { table, write } = await prepared.open({ io: imageGenerationIo({ directory: session, path: definition.path }), create: true });
      const runs = await imageGenerationRunTable({ directory: session, sessionId: record.sessionId, create: false });
      const current = await table.read({ id: record.id });
      if (current && !current.matches({ other: prepared.snapshot })) {
        throw new Error('Accepted operation membership is immutable.');
      }
      if (!current) {
        const metadata = await (await imageGenerationSessionTable({ directory, create: false })).load({ id: record.sessionId });

        const state = metadata?.state;
        switch (state) {
        case 'active': break;
        case undefined: case 'archived': case 'deleting': case 'deleted': throw new Error('The generation session is not active.');
        default: {
          const exhaustive: never = state;
          throw new Error(String(exhaustive));
        }
        }
        const legacy = await runs.load({ id: toImageGenerationRunId({ raw: idToRaw({ id: record.id }) }) });
        if (legacy && isLegacyImageGenerationRun({ run: legacy })) {
          throw new Error('An operation identity collides with a base-format run.');
        }
      }
      let imageCount = 0;
      for (const runId of record.runIds) {
        const run = await runs.load({ id: runId });
        if (!run || run.operationId !== record.id || !current && run.execution.type !== 'queued') {
          throw new Error('All operation requests must be saved with matching membership before acceptance.');
        }
        imageCount += run.seeds.length;
      }
      if (imageCount > 512) {
        throw new Error('A generation operation may contain at most 512 images.');
      }
      await write({
        assertCurrent({ current: latest, next }) {
          if (latest && !latest.matches({ other: next })) {
            throw new Error('Accepted operation membership is immutable.');
          }
        },
        async beforeCommit() {},
      });
    },
  });
}

export async function listImageGenerationOperations({ store, sessionId }: { store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId }): Promise<ImageGenerationReadResult<ImageGenerationOperation>> {
  validateImageGenerationId({ id: sessionId });
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await imageGenerationSessionDirectory({ directory, sessionId });
      if (!session) {
        throw new Error('The operation session no longer exists.');
      }
      const table = await imageGenerationOperationTable({ directory: session, sessionId, create: false });
      const listed = await table.list();
      const runTable = await imageGenerationRunTable({ directory: session, sessionId, create: false });
      const runList = await runTable.list();
      const runs = new Map(runList.items.map(run => [run.id, run]));
      const warnings = [...listed.warnings, ...runList.warnings];
      let warningCount = listed.warningCount + runList.warningCount;
      const warn = ({ path, message }: { path: string, message: string }) => {
        warningCount++;
        if (warnings.length < 100) {
          warnings.push({ path, message });
        }
      };
      const items: ImageGenerationOperation[] = [];
      const claimed = new Set<ImageGenerationRunId>();
      for (const summary of listed.items) {
        try {
          const record = await table.load({ id: summary.id });
          if (!record) {
            throw new Error('Operation record is missing.');
          }
          for (const id of record.runIds) {
            const run = await runTable.load({ id });
            if (!run || run.operationId !== record.id || claimed.has(id)) {
              throw new Error('Operation membership is incomplete or inconsistent.');
            }
          }
          record.runIds.forEach(id => claimed.add(id));
          items.push(record);
        } catch (error) {
          warn({ path: `operations/${idToRaw({ id: summary.id })}`, message: error instanceof Error ? error.message : String(error) });
        }
      }
      for (const run of runs.values()) {
        if (claimed.has(run.id)) {
          continue;
        }
        const legacy = legacyRunToOperation({ run, sessionId });
        if (legacy === undefined) {
          warn({ path: `runs/${idToRaw({ id: run.id })}`, message: 'The generation operation was not fully accepted. No automatic inference will be started.' });
          continue;
        }
        items.push(legacy);
      }
      items.sort((a, b) => b.createdAt - a.createdAt || idToRaw({ id: a.id }).localeCompare(idToRaw({ id: b.id })));
      return { items, warnings: warnings.slice(0, 100), warningCount };
    },
  });
}

/** Call under the existing image storage lock. */
export async function requireImageGenerationOperationMembership({ directory, sessionId, operationId, runId }: { directory: FileSystemDirectoryHandle, sessionId: ImageGenerationSessionId, operationId: ImageGenerationOperationId, runId: ImageGenerationRunId }): Promise<void> {
  const record = await (await imageGenerationOperationTable({ directory, sessionId, create: false })).load({ id: validateImageGenerationId({ id: operationId }) });
  if (!record || !record.runIds.includes(runId)) {
    throw new Error('The generation operation is not accepted.');
  }
}

export async function loadImageGenerationOperation({ store, sessionId, operationId }: { store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId, operationId: ImageGenerationOperationId }): Promise<ImageGenerationOperation> {
  validateImageGenerationId({ id: sessionId });
  const id = validateImageGenerationId({ id: operationId });
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await imageGenerationSessionDirectory({ directory, sessionId });
      if (!session) {
        throw new Error('The operation session no longer exists.');
      }
      const table = await imageGenerationOperationTable({ directory: session, sessionId, create: false });
      const runs = await imageGenerationRunTable({ directory: session, sessionId, create: false });
      const record = await table.load({ id });
      if (record) {
        for (const runId of record.runIds) {
          const run = await runs.load({ id: runId });
          if (!run || run.operationId !== id) {
            throw new Error('Operation membership is incomplete.');
          }
        }
        return record;
      }
      const legacy = legacyRunToOperation({ run: await runs.load({ id: toImageGenerationRunId({ raw: idToRaw({ id }) }) }), sessionId });
      if (legacy !== undefined) {
        return legacy;
      }
      throw new Error('The generation operation is missing or incomplete.');
    },
  });
}

export const TEST_ONLY = {
};
