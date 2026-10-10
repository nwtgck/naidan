import { imageInferenceLocationToDomain, imageInferenceLocationToDto, remoteImageModelEditorToDomain, remoteImageModelEditorToDto } from './image-generation-editor';
import { endpointToDomain, endpointToDto, lmParametersToDomain, lmParametersToDto } from './mappers';
import type { ImageGenerationTranslationOverride } from '@/01-models/image-generation';
import { ExperimentalImageGenerationTranslationOverrideSchemaDto, type ExperimentalImageGenerationTranslationOverrideDto } from '@/00-storage/00-dto/experimental-image-generation.dto';
import { browserImageModelSelectionToDomain, browserImageModelSelectionToDto } from './browser-image-model-selection';
import type { ImageGenerationSessionDraft } from '@/01-models/image-generation';
import type { ExperimentalImageGenerationDraftDto } from '@/00-storage/00-dto/experimental-image-generation.dto';
import type { ImageGenerationAsset, ImageGenerationAssetAnnotations, ImageGenerationAssetSummary, ImageGenerationCatalog, ImageGenerationRun, ImageGenerationRunSummary, ImageGenerationSession, ImageGenerationTagReference } from '@/01-models/image-generation';
import { idToRaw, toChatId, toBinaryObjectId, toImageGenerationAssetId, toImageGenerationRunId, toImageGenerationSessionId, toImageGenerationStoreId, toImageGenerationTagId } from '@/01-models/ids';
import { exactObject } from '@/utils/exact-object';
import type { ExperimentalImageGenerationAssetAnnotationsDto, ExperimentalImageGenerationAssetDto, ExperimentalImageGenerationAssetSummaryDto, ExperimentalImageGenerationCatalogDto, ExperimentalImageGenerationRunDto, ExperimentalImageGenerationRunSummaryDto, ExperimentalImageGenerationSessionDto, ExperimentalImageGenerationTagReferenceDto } from '@/00-storage/00-dto/experimental-image-generation.dto';
import { imageGenerationRuntimeToDomain, imageGenerationRuntimeToDto, imageGenerationRequestBodyToDomain, imageGenerationRequestBodyToDto, imageGenerationRequestToDomain, imageGenerationRequestToDto } from './image-generation-history';

export function imageGenerationDraftToDto({ draft }: { draft: ImageGenerationSessionDraft }): ExperimentalImageGenerationDraftDto {
  const { sessionId, request, inferenceLocation, modelSelection, remoteModelEditor, loraStates, ...metadata } = draft;
  const { runtime, ...body } = request;
  return exactObject<ExperimentalImageGenerationDraftDto>()({ ...metadata, inferenceLocation: inferenceLocation && imageInferenceLocationToDto({ location: inferenceLocation }), remoteModelEditor: remoteModelEditor && remoteImageModelEditorToDto({ editor: remoteModelEditor }), modelSelection: modelSelection && browserImageModelSelectionToDto({ domain: modelSelection }), loraStates: loraStates.map(state => ({ ...state })), sessionId: idToRaw({ id: sessionId }), request: { ...imageGenerationRequestBodyToDto({ request: body }), runtime: runtime && imageGenerationRuntimeToDto({ runtime }) } });
}

export function imageGenerationDraftToDomain({ dto }: { dto: ExperimentalImageGenerationDraftDto }): ImageGenerationSessionDraft {
  const { sessionId, request, inferenceLocation, modelSelection, remoteModelEditor, loraStates, ...metadata } = dto;
  const { runtime, ...body } = request;
  return exactObject<ImageGenerationSessionDraft>()({ ...metadata, inferenceLocation: inferenceLocation && imageInferenceLocationToDomain({ dto: inferenceLocation }), remoteModelEditor: remoteModelEditor && remoteImageModelEditorToDomain({ dto: remoteModelEditor }), modelSelection: modelSelection && browserImageModelSelectionToDomain({ dto: modelSelection }), loraStates: loraStates.map(state => ({ ...state })), sessionId: toImageGenerationSessionId({ raw: sessionId }), request: { ...imageGenerationRequestBodyToDomain({ request: body }), runtime: runtime && imageGenerationRuntimeToDomain({ runtime }) } });
}

export function imageGenerationTranslationToDto({ value }: { value: ImageGenerationTranslationOverride | undefined }): ExperimentalImageGenerationTranslationOverrideDto | undefined {
  if (!value) return undefined;
  const { endpoint, modelId, lmParameters, ...unhandled } = value;
  unhandled satisfies Record<PropertyKey, never>;
  return ExperimentalImageGenerationTranslationOverrideSchemaDto.parse({ endpoint: endpoint && endpointToDto({ endpoint }), modelId, lmParameters: lmParametersToDto({ domain: lmParameters }) });
}

export function imageGenerationTranslationToDomain({ value }: { value: ExperimentalImageGenerationTranslationOverrideDto | undefined }): ImageGenerationTranslationOverride | undefined {
  if (!value) return undefined;
  const { endpoint, modelId, lmParameters, ...unhandled } = value;
  unhandled satisfies Record<PropertyKey, never>;
  return { endpoint: endpoint && endpointToDomain({ dto: endpoint }), modelId, lmParameters: lmParametersToDomain({ dto: lmParameters }) };
}

export function imageGenerationCatalogToDto({ catalog }: { catalog: ImageGenerationCatalog }): ExperimentalImageGenerationCatalogDto {
  const { id, tags, preferences, ...metadata } = catalog;
  return exactObject<ExperimentalImageGenerationCatalogDto>()({ ...metadata, preferences: { ...preferences, translation: imageGenerationTranslationToDto({ value: preferences.translation }) }, version: 1, id: idToRaw({ id }), tags: tags.map(({ id, ...tag }) => ({ ...tag, id: idToRaw({ id }) })) });
}

export function imageGenerationCatalogToDomain({ dto }: { dto: ExperimentalImageGenerationCatalogDto }): ImageGenerationCatalog {
  const { version: _version, id, tags, preferences, ...metadata } = dto;
  return exactObject<ImageGenerationCatalog>()({ ...metadata, preferences: { ...preferences, generationMonitorPresentation: preferences.generationMonitorPresentation ?? 'visual', assistantVisibility: preferences.assistantVisibility ?? 'closed', translation: imageGenerationTranslationToDomain({ value: preferences.translation }) }, id: toImageGenerationStoreId({ raw: id }), tags: tags.map(({ id, ...tag }) => ({ ...tag, id: toImageGenerationTagId({ raw: id }) })) });
}

export function imageGenerationSessionToDto({ session }: { session: ImageGenerationSession }): ExperimentalImageGenerationSessionDto {
  return exactObject<ExperimentalImageGenerationSessionDto>()({ ...session, translation: imageGenerationTranslationToDto({ value: session.translation }), id: idToRaw({ id: session.id }), assistantChatId: session.assistantChatId && idToRaw({ id: session.assistantChatId }) });
}

export function imageGenerationSessionToDomain({ dto }: { dto: ExperimentalImageGenerationSessionDto }): ImageGenerationSession {
  return exactObject<ImageGenerationSession>()({ ...dto, translation: imageGenerationTranslationToDomain({ value: dto.translation }), id: toImageGenerationSessionId({ raw: dto.id }), assistantChatId: dto.assistantChatId === undefined ? undefined : toChatId({ raw: dto.assistantChatId }) });
}

export function imageGenerationRunToDto({ run }: { run: ImageGenerationRun }): ExperimentalImageGenerationRunDto {
  const { id, sessionId, request, sources, ...metadata } = run;
  return exactObject<ExperimentalImageGenerationRunDto>()({
    ...metadata,
    id: idToRaw({ id }),
    sessionId: idToRaw({ id: sessionId }),
    request: imageGenerationRequestToDto({ request }),
    sources: sources.map(({ sessionId, assetId, ...source }) => ({ ...source, sessionId: idToRaw({ id: sessionId }), assetId: idToRaw({ id: assetId }) })),
  });
}

export function imageGenerationRunToDomain({ dto }: { dto: ExperimentalImageGenerationRunDto }): ImageGenerationRun {
  const { id, sessionId, request, sources, ...metadata } = dto;
  return exactObject<ImageGenerationRun>()({
    ...metadata,
    id: toImageGenerationRunId({ raw: id }),
    sessionId: toImageGenerationSessionId({ raw: sessionId }),
    request: imageGenerationRequestToDomain({ request }),
    sources: sources.map(({ sessionId, assetId, ...source }) => ({ ...source, sessionId: toImageGenerationSessionId({ raw: sessionId }), assetId: toImageGenerationAssetId({ raw: assetId }) })),
  });
}

export function imageGenerationAssetToDto({ asset }: { asset: ImageGenerationAsset }): ExperimentalImageGenerationAssetDto {
  const { id, sessionId, runId, result, previews, ...metadata } = asset;
  return exactObject<ExperimentalImageGenerationAssetDto>()({
    ...metadata,
    id: idToRaw({ id }),
    sessionId: idToRaw({ id: sessionId }),
    runId: idToRaw({ id: runId }),
    result: { ...result, binaryObjectId: idToRaw({ id: result.binaryObjectId }) },
    previews: previews.map(preview => ({ ...preview, binaryObjectId: idToRaw({ id: preview.binaryObjectId }) })),
  });
}

export function imageGenerationAssetToDomain({ dto }: { dto: ExperimentalImageGenerationAssetDto }): ImageGenerationAsset {
  const { id, sessionId, runId, result, previews, ...metadata } = dto;
  return exactObject<ImageGenerationAsset>()({
    ...metadata,
    id: toImageGenerationAssetId({ raw: id }),
    sessionId: toImageGenerationSessionId({ raw: sessionId }),
    runId: toImageGenerationRunId({ raw: runId }),
    result: { ...result, binaryObjectId: toBinaryObjectId({ raw: result.binaryObjectId }) },
    previews: previews.map(preview => ({ ...preview, binaryObjectId: toBinaryObjectId({ raw: preview.binaryObjectId }) })),
  });
}

export function imageGenerationTagReferenceToDto({ tag }: { tag: ImageGenerationTagReference }): ExperimentalImageGenerationTagReferenceDto {
  switch (tag.type) {
  case 'system': return { ...tag };
  case 'user': return { ...tag, tagId: idToRaw({ id: tag.tagId }) };
  default: { const exhaustive: never = tag; throw new Error(String(exhaustive)); }
  }
}

export function imageGenerationTagReferenceToDomain({ dto }: { dto: ExperimentalImageGenerationTagReferenceDto }): ImageGenerationTagReference {
  switch (dto.type) {
  case 'system': return { ...dto };
  case 'user': return { ...dto, tagId: toImageGenerationTagId({ raw: dto.tagId }) };
  default: { const exhaustive: never = dto; throw new Error(String(exhaustive)); }
  }
}

export function imageGenerationAnnotationsToDomain({ dto }: { dto: ExperimentalImageGenerationAssetAnnotationsDto }): ImageGenerationAssetAnnotations {
  const { assetId, sessionId, tags, ...metadata } = dto;
  return exactObject<ImageGenerationAssetAnnotations>()({
    ...metadata,
    assetId: toImageGenerationAssetId({ raw: assetId }),
    sessionId: toImageGenerationSessionId({ raw: sessionId }),
    tags: tags.map(({ tag, ...assignment }) => ({ ...assignment, tag: imageGenerationTagReferenceToDomain({ dto: tag }) })),
  });
}

export function imageGenerationRunSummaryToDomain({ dto }: { dto: ExperimentalImageGenerationRunSummaryDto }): ImageGenerationRunSummary {
  return exactObject<ImageGenerationRunSummary>()({ ...dto, id: toImageGenerationRunId({ raw: dto.id }), sessionId: toImageGenerationSessionId({ raw: dto.sessionId }) });
}

export function imageGenerationAssetSummaryToDomain({ dto }: { dto: ExperimentalImageGenerationAssetSummaryDto }): ImageGenerationAssetSummary {
  return exactObject<ImageGenerationAssetSummary>()({ ...dto, id: toImageGenerationAssetId({ raw: dto.id }), sessionId: toImageGenerationSessionId({ raw: dto.sessionId }), runId: toImageGenerationRunId({ raw: dto.runId }), binaryObjectId: toBinaryObjectId({ raw: dto.binaryObjectId }) });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
