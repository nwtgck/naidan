import { ExperimentalImageGenerationOperationSchemaDto, ExperimentalImageGenerationOperationIndexSchemaDto, type ExperimentalImageGenerationOperationDto } from '@/00-storage/00-dto/experimental-image-generation.dto';
import type { ImageGenerationOperation, ImageGenerationReadResult } from '@/01-models/image-generation';
import { idToRaw, toImageGenerationOperationId, toImageGenerationRunId, toImageGenerationSessionId, type ImageGenerationOperationId, type ImageGenerationSessionId } from '@/01-models/ids';
import { withImageGenerationStore, type ImageGenerationStoreAccess } from './context';
import { createImageGenerationTable, imageGenerationDirectory, imageGenerationRawIdSchema } from './files';
import { imageGenerationSessionDirectory, imageGenerationRunTable, imageGenerationSessionTable } from './tables';

function validateOperation({ record, sessionId }: { record: ExperimentalImageGenerationOperationDto, sessionId: string }): void {
  imageGenerationRawIdSchema.parse(record.id);
  if (record.sessionId !== sessionId || !Number.isFinite(record.createdAt) || !record.runIds.length || record.runIds.length > 128 || new Set(record.runIds).size !== record.runIds.length) {
    throw new Error('Invalid image generation operation membership.');
  }
  for (const id of record.runIds) {
    imageGenerationRawIdSchema.parse(id);
  }
}

export async function imageGenerationOperationTable({ directory, sessionId, create }: { directory: FileSystemDirectoryHandle, sessionId: string, create: boolean }) {
  return createImageGenerationTable({
    directory: await imageGenerationDirectory({ parent: directory, name: 'operations', create }),
    layout: 'files',
    recordSchema: ExperimentalImageGenerationOperationSchemaDto,
    indexSchema: ExperimentalImageGenerationOperationIndexSchemaDto,
    recordId: ({ record }) => record.id,
    summaryId: ({ summary }) => summary.id,
    summarize: ({ record }) => ({ ...record, runIds: [...record.runIds] }),
    validateRecord: ({ record }) => validateOperation({ record, sessionId }),
    validateSummary: ({ summary }) => validateOperation({ record: summary, sessionId }),
    unavailableRecord: undefined,
  });
}

function toDomain({ dto }: { dto: ExperimentalImageGenerationOperationDto }): ImageGenerationOperation {
  const { version: _version, id, sessionId, runIds, ...rest } = dto;
  return { ...rest, id: toImageGenerationOperationId({ raw: id }), sessionId: toImageGenerationSessionId({ raw: sessionId }), runIds: runIds.map(raw => toImageGenerationRunId({ raw })) };
}

/** Parent last is the acceptance marker. No inference begins until this write
 * succeeds. A lost acknowledgement retries identical IDs and membership. */
export async function saveImageGenerationOperation({ store, operation }: { store: ImageGenerationStoreAccess, operation: ImageGenerationOperation }): Promise<void> {
  const record = ExperimentalImageGenerationOperationSchemaDto.parse({ ...operation, version: 1, id: idToRaw({ id: operation.id }), sessionId: idToRaw({ id: operation.sessionId }), runIds: operation.runIds.map(id => idToRaw({ id })) });
  imageGenerationRawIdSchema.parse(record.sessionId);
  validateOperation({ record, sessionId: record.sessionId });
  await withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await imageGenerationSessionDirectory({ directory, sessionId: record.sessionId });
      if (!session) {
        throw new Error('The operation session no longer exists.');
      }
      const table = await imageGenerationOperationTable({ directory: session, sessionId: record.sessionId, create: true });
      const runs = await imageGenerationRunTable({ directory: session, sessionId: record.sessionId, create: false });
      const current = await table.load({ id: record.id });
      const serialized = JSON.stringify(record);
      if (current && JSON.stringify(current) !== serialized) {
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
        const legacy = await runs.load({ id: record.id });
        if (legacy && legacy.operationId === undefined) {
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
      await table.write({
        record,
        assertCurrent({ current: latest }) {
          if (latest && JSON.stringify(latest) !== serialized) {
            throw new Error('Accepted operation membership is immutable.');
          }
        },
        async beforeCommit() {},
      });
    },
  });
}

export async function listImageGenerationOperations({ store, sessionId }: { store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId }): Promise<ImageGenerationReadResult<ImageGenerationOperation>> {
  const raw = imageGenerationRawIdSchema.parse(idToRaw({ id: sessionId }));
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await imageGenerationSessionDirectory({ directory, sessionId: raw });
      if (!session) {
        throw new Error('The operation session no longer exists.');
      }
      const table = await imageGenerationOperationTable({ directory: session, sessionId: raw, create: false });
      const listed = await table.list();
      const runTable = await imageGenerationRunTable({ directory: session, sessionId: raw, create: false });
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
      const claimed = new Set<string>();
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
          items.push(toDomain({ dto: record }));
        } catch (error) {
          warn({ path: `operations/${summary.id}`, message: error instanceof Error ? error.message : String(error) });
        }
      }
      for (const run of runs.values()) {
        if (claimed.has(run.id)) {
          continue;
        }
        if (run.operationId !== undefined) {
          warn({ path: `runs/${run.id}`, message: 'The generation operation was not fully accepted. No automatic inference will be started.' });
          continue;
        }
        // The only migration input is the base ZIP. Read-only singleton projection
        // avoids rewriting old runs, assets, annotations or image identities.
        items.push({ id: toImageGenerationOperationId({ raw: run.id }), sessionId, createdAt: run.createdAt, runIds: [toImageGenerationRunId({ raw: run.id })] });
      }
      items.sort((a, b) => b.createdAt - a.createdAt || idToRaw({ id: a.id }).localeCompare(idToRaw({ id: b.id })));
      return { items, warnings: warnings.slice(0, 100), warningCount };
    },
  });
}

/** Call under the existing image storage lock. */
export async function requireImageGenerationOperationMembership({ directory, sessionId, operationId, runId }: { directory: FileSystemDirectoryHandle, sessionId: string, operationId: string, runId: string }): Promise<void> {
  const record = await (await imageGenerationOperationTable({ directory, sessionId, create: false })).load({ id: imageGenerationRawIdSchema.parse(operationId) });
  if (!record || !record.runIds.includes(runId)) {
    throw new Error('The generation operation is not accepted.');
  }
}

export async function loadImageGenerationOperation({ store, sessionId, operationId }: { store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId, operationId: ImageGenerationOperationId }): Promise<ImageGenerationOperation> {
  const raw = imageGenerationRawIdSchema.parse(idToRaw({ id: sessionId }));
  const id = imageGenerationRawIdSchema.parse(idToRaw({ id: operationId }));
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await imageGenerationSessionDirectory({ directory, sessionId: raw });
      if (!session) {
        throw new Error('The operation session no longer exists.');
      }
      const table = await imageGenerationOperationTable({ directory: session, sessionId: raw, create: false });
      const runs = await imageGenerationRunTable({ directory: session, sessionId: raw, create: false });
      const record = await table.load({ id });
      if (record) {
        for (const runId of record.runIds) {
          const run = await runs.load({ id: runId });
          if (!run || run.operationId !== id) {
            throw new Error('Operation membership is incomplete.');
          }
        }
        return toDomain({ dto: record });
      }
      const legacy = await runs.load({ id });
      if (legacy && legacy.operationId === undefined) {
        return { id: operationId, sessionId, createdAt: legacy.createdAt, runIds: [toImageGenerationRunId({ raw: legacy.id })] };
      }
      throw new Error('The generation operation is missing or incomplete.');
    },
  });
}

export const TEST_ONLY = {
};
