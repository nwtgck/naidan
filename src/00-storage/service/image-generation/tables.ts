import { exactObject } from '@/utils/exact-object';
import {
  ExperimentalImageGenerationSessionSchemaDto, ExperimentalImageGenerationSessionIndexSchemaDto,
  ExperimentalImageGenerationRunSchemaDto, ExperimentalImageGenerationRunIndexSchemaDto,
  ExperimentalImageGenerationAssetSchemaDto, ExperimentalImageGenerationAssetIndexSchemaDto,
  ExperimentalImageGenerationAssetAnnotationsSchemaDto, ExperimentalImageGenerationAnnotationsIndexSchemaDto,
  type ExperimentalImageGenerationRunDto, type ExperimentalImageGenerationRunSummaryDto,
  type ExperimentalImageGenerationAssetDto, type ExperimentalImageGenerationAssetSummaryDto,
} from '@/00-storage/00-dto/experimental-image-generation.dto';
import { createImageGenerationTable, imageGenerationDirectory, imageGenerationRawIdSchema } from './files';

function assertSessionIdentity({ actual, expected }: { actual: string, expected: string }): void {
  if (actual !== expected) throw new Error('Image Generation record belongs to a different session.');
}

function summarizeRun({ record }: { record: ExperimentalImageGenerationRunDto }): ExperimentalImageGenerationRunSummaryDto {
  const { id, sessionId, revision, createdAt, execution, request, seeds, sources: _sources, acceptedOrder: _acceptedOrder, ...unhandled } = record;
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<ExperimentalImageGenerationRunSummaryDto>()({
    id,
    sessionId,
    revision,
    createdAt,
    execution,
    prompt: request.parameters.prompt,
    modelName: (() => {
      const runtime = request.runtime;
      switch (runtime.profile) {
      case 'naidan-rpc': return runtime.modelSelection?.primary.file.location.path ?? runtime.label;
      case 'webgpu-wasm32-asyncify': case 'webgpu-wasm32-jspi': case 'webgpu-wasm64-jspi': return request.models.find(model => model.slot === 'model' || model.slot === 'diffusion')?.file.name ?? '';
      default: { const exhaustive: never = runtime; throw new Error(String(exhaustive)); }
      }
    })(),
    requestedCount: seeds.length,
  });
}
function summarizeAsset({ record }: { record: ExperimentalImageGenerationAssetDto }): ExperimentalImageGenerationAssetSummaryDto {
  const { result, previews, ...metadata } = record;
  const { binaryObjectId, width, height, confirmation, modelVersion: _modelVersion, uniformOutput: _uniformOutput, elapsedMs: _elapsedMs, ...unhandled } = result;
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<ExperimentalImageGenerationAssetSummaryDto>()({
    ...metadata,
    ...(() => {
      switch (confirmation) {
      case 'unconfirmed': return { confirmation };
      case 'confirmed': case undefined: return {};
      default: { const exhaustive: never = confirmation; throw new Error(String(exhaustive)); }
      }
    })(),
    binaryObjectId,
    width,
    height,
    previewCount: previews.length,
  });
}

export async function imageGenerationSessionTable({ directory, create }: { directory: FileSystemDirectoryHandle, create: boolean }) {
  const sessions = await imageGenerationDirectory({ parent: directory, name: 'sessions', create });
  return createImageGenerationTable({
    directory: sessions,
    layout: 'session-directories',
    recordSchema: ExperimentalImageGenerationSessionSchemaDto,
    indexSchema: ExperimentalImageGenerationSessionIndexSchemaDto,
    recordId: ({ record }) => record.id,
    summaryId: ({ summary }) => summary.id,
    summarize: ({ record }) => ({ ...record }),
    validateRecord() {},
    validateSummary() {},
  });
}

export async function imageGenerationSessionDirectory({ directory, sessionId }: { directory: FileSystemDirectoryHandle, sessionId: string }): Promise<FileSystemDirectoryHandle | undefined> {
  imageGenerationRawIdSchema.parse(sessionId);
  let parent = directory;
  for (const name of ['sessions', sessionId.slice(-2).toLowerCase(), sessionId]) {
    const next = await imageGenerationDirectory({ parent, name, create: false });
    if (!next) return undefined;
    parent = next;
  }
  // A directory is not a session without a validated canonical session record.
  const session = await (await imageGenerationSessionTable({ directory, create: false })).load({ id: sessionId });
  return session && session.state !== 'deleted' && session.state !== 'deleting' ? parent : undefined;
}

export async function imageGenerationRunTable({ directory, sessionId, create }: { directory: FileSystemDirectoryHandle, sessionId: string, create: boolean }) {
  const records = await imageGenerationDirectory({ parent: directory, name: 'runs', create });
  return createImageGenerationTable({
    directory: records,
    layout: 'files',
    recordSchema: ExperimentalImageGenerationRunSchemaDto,
    indexSchema: ExperimentalImageGenerationRunIndexSchemaDto,
    recordId: ({ record }) => record.id,
    summaryId: ({ summary }) => summary.id,
    summarize: summarizeRun,
    validateRecord: ({ record }) => assertSessionIdentity({ actual: record.sessionId, expected: sessionId }),
    validateSummary: ({ summary }) => assertSessionIdentity({ actual: summary.sessionId, expected: sessionId }),
  });
}
export async function imageGenerationAssetTable({ directory, sessionId, create }: { directory: FileSystemDirectoryHandle, sessionId: string, create: boolean }) {
  const records = await imageGenerationDirectory({ parent: directory, name: 'assets', create });
  return createImageGenerationTable({
    directory: records,
    layout: 'files',
    recordSchema: ExperimentalImageGenerationAssetSchemaDto,
    indexSchema: ExperimentalImageGenerationAssetIndexSchemaDto,
    recordId: ({ record }) => record.id,
    summaryId: ({ summary }) => summary.id,
    summarize: summarizeAsset,
    validateRecord: ({ record }) => assertSessionIdentity({ actual: record.sessionId, expected: sessionId }),
    validateSummary: ({ summary }) => assertSessionIdentity({ actual: summary.sessionId, expected: sessionId }),
  });
}
export async function imageGenerationAnnotationsTable({ directory, sessionId, create }: { directory: FileSystemDirectoryHandle, sessionId: string, create: boolean }) {
  const records = await imageGenerationDirectory({ parent: directory, name: 'annotations', create });
  return createImageGenerationTable({
    directory: records,
    layout: 'files',
    recordSchema: ExperimentalImageGenerationAssetAnnotationsSchemaDto,
    indexSchema: ExperimentalImageGenerationAnnotationsIndexSchemaDto,
    recordId: ({ record }) => record.assetId,
    summaryId: ({ summary }) => summary.assetId,
    summarize: ({ record }) => ({ ...record }),
    validateRecord: ({ record }) => assertSessionIdentity({ actual: record.sessionId, expected: sessionId }),
    validateSummary: ({ summary }) => assertSessionIdentity({ actual: summary.sessionId, expected: sessionId }),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
