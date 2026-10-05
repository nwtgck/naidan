import { describe, expect, it } from 'vitest';
import { ExperimentalImageGenerationAssetAnnotationsSchemaDto, ExperimentalImageGenerationCatalogSchemaDto, ExperimentalImageGenerationRunSchemaDto, type ExperimentalImageGenerationRunDto } from '@/00-storage/00-dto/experimental-image-generation.dto';
import { imageGenerationRunToDomain, imageGenerationRunToDto } from '@/00-storage/mapper/image-generation';
import { imageGenerationRequestToDomain, imageGenerationRequestToDto, imageGenerationToDomain, imageGenerationToDto } from '@/00-storage/mapper/image-generation-history';
import { toImageGenerationId, toImageGenerationSessionId } from '@/01-models/ids';
import { generationAssetFixture, generationRunFixture } from './image-generation/test-support';

function runFixture() {
  return generationRunFixture({ id: 'run-aa', sessionId: toImageGenerationSessionId({ raw: 'session-aa' }), count: 4, seed: '9007199254740993' });
}

describe('strict Image Generation persistence contracts', () => {
  it('round-trips exact large seeds and the complete request through JSON serialization', () => {
    const run = runFixture();
    const parsed = ExperimentalImageGenerationRunSchemaDto.parse(JSON.parse(JSON.stringify(imageGenerationRunToDto({ run }))));
    expect(imageGenerationRunToDomain({ dto: parsed })).toEqual(run);
    expect(parsed.seeds).toEqual(['9007199254740993', '9007199254740994', '9007199254740995', '9007199254740996']);
  });
  const futureShapes: { name: string, extend: ({ dto }: { dto: ExperimentalImageGenerationRunDto }) => unknown }[] = [
    { name: 'run', extend: ({ dto }) => ({ ...dto, future: true }) },
    { name: 'request', extend: ({ dto }) => ({ ...dto, request: { ...dto.request, future: true } }) },
    { name: 'parameters', extend: ({ dto }) => ({ ...dto, request: { ...dto.request, parameters: { ...dto.request.parameters, future: true } } }) },
    { name: 'runtime', extend: ({ dto }) => ({ ...dto, request: { ...dto.request, runtime: { ...dto.request.runtime, future: true } } }) },
    { name: 'preview', extend: ({ dto }) => ({ ...dto, request: { ...dto.request, preview: { ...dto.request.preview, future: true } } }) },
    { name: 'model', extend: ({ dto }) => ({ ...dto, request: { ...dto.request, models: dto.request.models.map(model => ({ ...model, future: true })) } }) },
    { name: 'model file', extend: ({ dto }) => ({ ...dto, request: { ...dto.request, models: dto.request.models.map(model => ({ ...model, file: { ...model.file, future: true } })) } }) },
    { name: 'companion', extend: ({ dto }) => ({ ...dto, request: { ...dto.request, models: dto.request.models.map(model => ({ ...model, companions: model.companions.map(companion => ({ ...companion, future: true })) })) } }) },
    { name: 'companion file', extend: ({ dto }) => ({ ...dto, request: { ...dto.request, models: dto.request.models.map(model => ({ ...model, companions: model.companions.map(companion => ({ ...companion, file: { ...companion.file, future: true } })) })) } }) },
    { name: 'adapter', extend: ({ dto }) => ({ ...dto, request: { ...dto.request, loras: dto.request.loras.map(lora => ({ ...lora, future: true })) } }) },
    { name: 'adapter file', extend: ({ dto }) => ({ ...dto, request: { ...dto.request, loras: dto.request.loras.map(lora => ({ ...lora, file: { ...lora.file, future: true } })) } }) },
    { name: 'image inputs', extend: ({ dto }) => ({ ...dto, request: { ...dto.request, imageInputs: { ...dto.request.imageInputs, future: true } } }) },
    { name: 'initial image', extend: ({ dto }) => ({ ...dto, request: { ...dto.request, imageInputs: { ...dto.request.imageInputs, initImage: { ...dto.request.imageInputs.initImage, future: true } } } }) },
    { name: 'reference image', extend: ({ dto }) => ({ ...dto, request: { ...dto.request, imageInputs: { ...dto.request.imageInputs, referenceImages: dto.request.imageInputs.referenceImages.map(image => ({ ...image, future: true })) } } }) },
    { name: 'execution', extend: ({ dto }) => ({ ...dto, execution: { ...dto.execution, future: true } }) },
    { name: 'lineage', extend: ({ dto }) => ({ ...dto, sources: [{ role: 'settings', sessionId: 'session-bb', assetId: 'asset-aa', future: true }] }) },
  ];
  it.each(futureShapes)('rejects rather than silently strips unknown $name fields', ({ extend }) => {
    expect(ExperimentalImageGenerationRunSchemaDto.safeParse(extend({ dto: imageGenerationRunToDto({ run: runFixture() }) })).success).toBe(false);
  });
  it('does not confuse immutable output plans with requested random seeds', () => {
    const dto = imageGenerationRunToDto({ run: runFixture() });
    expect(ExperimentalImageGenerationRunSchemaDto.safeParse({ ...dto, seeds: ['1', '2', '3', '4'] }).success).toBe(false);
    expect(ExperimentalImageGenerationRunSchemaDto.safeParse({ ...dto, request: { ...dto.request, parameters: { ...dto.request.parameters, seed: '-1' } } }).success).toBe(false);
  });
  it.each(['候補', 'CANDIDATE', 'ガ'])('rejects duplicate or unnormalized catalog labels: %s', name => {
    const sameKeyName = name === 'CANDIDATE' ? 'candidate' : name;
    const catalog = { version: 1, id: 'store-aa', revision: 0, createdAt: 1, preferences: { assistantLayout: 'floating' }, tags: [
      { id: 'tag-aa', name, createdAt: 1, updatedAt: 1, state: 'active' },
      { id: 'tag-bb', name: sameKeyName, createdAt: 1, updatedAt: 1, state: 'archived' },
    ] };
    expect(ExperimentalImageGenerationCatalogSchemaDto.safeParse(catalog).success).toBe(false);
  });
  it('keeps reserved system tags structurally distinct from user identifiers', () => {
    const annotations = { assetId: 'asset-aa', sessionId: 'session-aa', revision: 1, state: 'active' as const, tags: [
      { tag: { type: 'system', key: 'favorite' }, assignedAt: 1 },
      { tag: { type: 'user', tagId: 'favorite' }, assignedAt: 2 },
    ] };
    expect(ExperimentalImageGenerationAssetAnnotationsSchemaDto.parse(annotations).tags).toHaveLength(2);
    expect(ExperimentalImageGenerationAssetAnnotationsSchemaDto.safeParse({ ...annotations, tags: [{ tag: { type: 'system', key: 'custom' }, assignedAt: 1 }] }).success).toBe(false);
  });
});

describe('legacy request mapper reuse', () => {
  it('does not change existing single-image history mapping', () => {
    const run = runFixture(); const asset = generationAssetFixture({ id: 'asset-aa', run, index: 0 });
    const record = { id: toImageGenerationId({ raw: 'legacy-aa' }), createdAt: run.createdAt, request: run.request, result: asset.result, previews: asset.previews };
    expect(imageGenerationToDomain({ dto: imageGenerationToDto({ record }) })).toEqual(record);
    expect(imageGenerationRequestToDomain({ request: imageGenerationRequestToDto({ request: run.request }) })).toEqual(run.request);
  });
});

describe('experimental presentation preferences', () => {
  it('keeps the acknowledgement and dock choice in the global catalog, not individual sessions', () => {
    const raw = { version: 1, id: 'catalog-aa', revision: 1, createdAt: 1, tags: [], preferences: { assistantLayout: 'docked', experimentalNoticeDismissedAt: 2 } };
    const dto = ExperimentalImageGenerationCatalogSchemaDto.parse(JSON.parse(JSON.stringify(raw)));
    expect(dto.preferences).toEqual({ assistantLayout: 'docked', experimentalNoticeDismissedAt: 2 });
  });
  it('accepts an unacknowledged fresh catalog', () => {
    const raw = { version: 1, id: 'catalog-aa', revision: 0, createdAt: 1, tags: [], preferences: { assistantLayout: 'floating' } };
    expect(ExperimentalImageGenerationCatalogSchemaDto.parse(raw).preferences.experimentalNoticeDismissedAt).toBeUndefined();
  });
  it.each([
    { assistantLayout: 'unknown' },
    { assistantLayout: 'docked', experimentalNoticeDismissedAt: -1 },
    { assistantLayout: 'docked', experimentalNoticeDismissedAt: '2' },
    { assistantLayout: 'docked', experimentalNoticeDismissedAt: Number.POSITIVE_INFINITY },
    { assistantLayout: 'docked', unrecognizedPreference: true },
  ])('rejects invalid or unknown preferences instead of discarding them: %j', preferences => {
    expect(ExperimentalImageGenerationCatalogSchemaDto.safeParse({ version: 1, id: 'catalog-aa', revision: 1, createdAt: 1, tags: [], preferences }).success).toBe(false);
  });
});
