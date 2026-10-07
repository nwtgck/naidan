import { z } from 'zod';
import { idToRaw, toBinaryObjectId, toImageGenerationAssetId, toImageGenerationRunId, toImageGenerationSessionId, toImageGenerationStoreId, toImageGenerationTagId } from '@/01-models/ids';
import type { ImageGenerationAssetPage, ImageGenerationAssetQuery, ImageGenerationReadResult, ImageGenerationRunSummary } from '@/01-models/image-generation';
import type { ImageGenerationStoreAccess } from '@/00-storage/service/image-generation';
import { missingAsUndefined, resolveMissingAsUndefined } from '@/utils/zod/missingAsUndefined';

// Worker transport, not a persisted DTO or a Chat tool protocol.
const rawId = z.string().regex(/^[a-zA-Z0-9_-]{2,128}$/);
const assetId = rawId.transform(raw => toImageGenerationAssetId({ raw }));
const sessionId = rawId.transform(raw => toImageGenerationSessionId({ raw }));
const runId = rawId.transform(raw => toImageGenerationRunId({ raw }));
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const tag = z.discriminatedUnion('type', [
  z.object({ type: z.literal('system'), key: z.literal('favorite') }).strict(),
  z.object({ type: z.literal('user'), tagId: rawId.transform(raw => toImageGenerationTagId({ raw })) }).strict(),
]);
const cursor = z.object({ createdAt: integer, id: assetId }).strict();
export const generationQueryRequestSchema = z.object({
  store: z.object({ storageType: z.literal('opfs'), storeId: rawId.transform(raw => toImageGenerationStoreId({ raw })) }).strict(),
  sessionId,
  query: resolveMissingAsUndefined(z.object({
    visibility: z.enum(['active', 'archived', 'all']),
    text: z.string().max(4096),
    tags: z.array(tag).max(256),
    match: z.enum(['all', 'any']),
    runId: missingAsUndefined(runId),
    cursor: missingAsUndefined(cursor),
    limit: z.number().int().min(1).max(100),
  }).strict()),
}).strict();
const warnings = z.array(z.object({ path: z.string().max(2048), message: z.string().max(32768) }).strict()).max(100);
const execution = z.discriminatedUnion('type', [
  z.object({ type: z.literal('queued') }).strict(),
  z.object({ type: z.literal('running'), startedAt: integer }).strict(),
  z.object({ type: z.literal('completed'), finishedAt: integer }).strict(),
  z.object({ type: z.literal('cancelled'), finishedAt: integer }).strict(),
  z.object({ type: z.literal('failed'), finishedAt: integer, message: z.string().max(32768) }).strict(),
  z.object({ type: z.literal('interrupted'), finishedAt: integer }).strict(),
]);
export const generationQueryResultSchema = z.object({
  runsWithAssets: z.array(runId),
  deletedAssetIds: z.array(assetId),
  pendingDeletions: z.array(z.object({ assetId, sessionId, revision: integer }).strict()),
  page: resolveMissingAsUndefined(z.object({
    items: z.array(resolveMissingAsUndefined(z.object({
      confirmation: z.literal('unconfirmed').optional(),
      id: assetId,
      sessionId,
      runId,
      index: z.number().int().min(0).max(63),
      createdAt: integer,
      seed: z.string().max(19).regex(/^(0|[1-9][0-9]*)$/).refine(value => BigInt(value) <= 9223372036854775807n),
      binaryObjectId: rawId.transform(raw => toBinaryObjectId({ raw })),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      previewCount: z.number().int().min(0).max(100),
      annotations: missingAsUndefined(z.object({ assetId, sessionId, revision: integer, state: z.enum(['active', 'archived', 'deleting', 'deleted']), tags: z.array(z.object({ tag, assignedAt: integer }).strict()).max(256) }).strict()),
    }).strict())).max(100),
    total: integer,
    nextCursor: missingAsUndefined(cursor),
    warnings,
    warningCount: integer,
  }).strict()),
  runs: z.object({ items: z.array(z.object({ id: runId, sessionId, revision: integer, createdAt: integer, prompt: z.string(), modelName: z.string(), requestedCount: z.number().int().min(1).max(64), execution }).strict()), warnings, warningCount: integer }).strict(),
}).strict();
export type ImageGenerationQuery = { store: ImageGenerationStoreAccess, sessionId: ImageGenerationRunSummary['sessionId'], query: ImageGenerationAssetQuery };
export type ImageGenerationQueryResult = { runsWithAssets: ReturnType<typeof toImageGenerationRunId>[], deletedAssetIds: ReturnType<typeof toImageGenerationAssetId>[], pendingDeletions: { assetId: ReturnType<typeof toImageGenerationAssetId>, sessionId: ReturnType<typeof toImageGenerationSessionId>, revision: number }[], page: ImageGenerationAssetPage, runs: ImageGenerationReadResult<ImageGenerationRunSummary> };
export interface ImageGenerationQueryWorker { query({ request }: { request: z.input<typeof generationQueryRequestSchema> }): Promise<z.input<typeof generationQueryResultSchema>> }
export interface ImageGenerationQueryClient {
  query({ store, sessionId, query }: ImageGenerationQuery): Promise<ImageGenerationQueryResult>,
  dispose(): Promise<void>,
}
/** Branded IDs stay inside their owner. Worker boundaries use explicit strings. */
function tagToWire({ value }: { value: z.output<typeof tag> }): z.input<typeof tag> {
  switch (value.type) {
  case 'system': return { type: 'system', key: value.key };
  case 'user': return { type: 'user', tagId: idToRaw({ id: value.tagId }) };
  default: { const exhaustive: never = value; throw new Error(String(exhaustive)); }
  }
}
export function generationQueryToWire({ value }: { value: ImageGenerationQuery }): z.input<typeof generationQueryRequestSchema> {
  switch (value.store.storageType) {
  case 'opfs': break;
  case 'memory': case 'local': throw new Error('Image Generation queries require OPFS.');
  default: { const exhaustive: never = value.store.storageType; throw new Error(String(exhaustive)); }
  }
  return {
    store: { storageType: value.store.storageType, storeId: idToRaw({ id: value.store.storeId }) },
    sessionId: idToRaw({ id: value.sessionId }),
    query: {
      ...value.query,
      tags: value.query.tags.map(tag => tagToWire({ value: tag })),
      runId: value.query.runId && idToRaw({ id: value.query.runId }),
      cursor: value.query.cursor && { ...value.query.cursor, id: idToRaw({ id: value.query.cursor.id }) },
    },
  };
}
export function generationResultToWire({ value }: { value: ImageGenerationQueryResult }): z.input<typeof generationQueryResultSchema> {
  return {
    runsWithAssets: value.runsWithAssets.map(id => idToRaw({ id })),
    deletedAssetIds: value.deletedAssetIds.map(id => idToRaw({ id })),
    pendingDeletions: value.pendingDeletions.map(item => ({ ...item, assetId: idToRaw({ id: item.assetId }), sessionId: idToRaw({ id: item.sessionId }) })),
    page: {
    ...value.page,
    items: value.page.items.map(item => ({
    ...item,
    id: idToRaw({ id: item.id }),
    sessionId: idToRaw({ id: item.sessionId }),
    runId: idToRaw({ id: item.runId }),
    binaryObjectId: idToRaw({ id: item.binaryObjectId }),
    annotations: item.annotations && {
      ...item.annotations,
      assetId: idToRaw({ id: item.annotations.assetId }),
      sessionId: idToRaw({ id: item.annotations.sessionId }),
      tags: item.annotations.tags.map(assignment => ({ ...assignment, tag: tagToWire({ value: assignment.tag }) })),
    },
  })),
  nextCursor: value.page.nextCursor && { ...value.page.nextCursor, id: idToRaw({ id: value.page.nextCursor.id }) },
  },
  runs: { ...value.runs, items: value.runs.items.map(run => ({ ...run, id: idToRaw({ id: run.id }), sessionId: idToRaw({ id: run.sessionId }) })) },
  };
}
export const TEST_ONLY = {
};
