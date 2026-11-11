import { describe, expect, it } from 'vitest';
import { ExperimentalImageGenerationAssetAnnotationsSchemaDto, ExperimentalImageGenerationCatalogSchemaDto, ExperimentalImageGenerationRunSchemaDto, ExperimentalImageGenerationSchemaDto, ExperimentalImageGenerationAssetSchemaDto, type ExperimentalImageGenerationRunDto } from '@/00-storage/00-dto/experimental-image-generation.dto';
import { imageGenerationRunToDomain, imageGenerationRunToDto, imageGenerationAssetToDomain, imageGenerationAssetToDto } from '@/00-storage/mapper/image-generation';
import { imageGenerationRequestToDomain, imageGenerationRequestToDto, imageGenerationToDomain, imageGenerationToDto } from '@/00-storage/mapper/image-generation-history';
import { toImageGenerationId, toImageGenerationSessionId } from '@/01-models/ids';
import { generationAssetFixture, generationRunFixture } from './image-generation/index.test-support';

function runFixture() {
  return generationRunFixture({ id: 'run-aa', sessionId: toImageGenerationSessionId({ raw: 'session-aa' }), count: 4, seed: '9007199254740993' });
}

describe('Image Generation persistence contracts', () => {
  it.each([undefined, 'f32', 'f16', 'bf16'] as const)('roundtrips the exact BF16 choice and preserves an omitted legacy field through the real history DTO: %s', bf16WeightType => {
    const run = runFixture();
    if (bf16WeightType === undefined) {
      delete run.request.parameters.bf16WeightType;
    } else {
      run.request.parameters.bf16WeightType = bf16WeightType;
    }
    const json = JSON.parse(JSON.stringify(imageGenerationRunToDto({ run })));
    const restored = imageGenerationRunToDomain({ dto: ExperimentalImageGenerationRunSchemaDto.parse(json) });
    expect(restored).toEqual(run);
    expect(restored.request.parameters.bf16WeightType).toBe(bf16WeightType);
    if (bf16WeightType === undefined) {
      expect(json.request.parameters).not.toHaveProperty('bf16WeightType');
    }
  });

  it.each(['steps', 'guidance'] as const)('keeps accepted history %s numeric rather than persisting authoring auto in the request', field => {
    const dto = imageGenerationRunToDto({ run: runFixture() });
    const parsed = ExperimentalImageGenerationRunSchemaDto.parse(dto);
    expect(typeof parsed.request.parameters[field]).toBe('number');
    expect(ExperimentalImageGenerationRunSchemaDto.safeParse({ ...dto, request: { ...dto.request, parameters: { ...dto.request.parameters, [field]: 'auto' } } }).success).toBe(false);
  });

  it.each(['confirmed', 'unconfirmed'] as const)('round-trips optional execution receipts including names outside UI choices: %s', confirmation => {
    const run = runFixture();
    const asset = generationAssetFixture({ id: 'asset-aa', run, index: 0 });
    const record = { id: toImageGenerationId({ raw: 'legacy-aa' }), createdAt: run.createdAt, request: run.request, result: asset.result, previews: asset.previews };
    record.request.parameters.sampler = 'auto';
    record.request.parameters.scheduler = 'auto';
    record.result.confirmation = confirmation;
    const legacyDto = ExperimentalImageGenerationSchemaDto.parse(JSON.parse(JSON.stringify(imageGenerationToDto({ record }))));
    expect(imageGenerationToDomain({ dto: legacyDto }).result).not.toHaveProperty('sampling');
    expect(imageGenerationToDomain({ dto: legacyDto }).result).not.toHaveProperty('resolvedParameters');
    record.result.sampling = { sampler: { id: 9, name: 'flux' }, scheduler: { id: 7 } };
    record.result.resolvedParameters = { steps: 6, guidance: 1, vaeTileSize: 16 };
    const dto = ExperimentalImageGenerationSchemaDto.parse(JSON.parse(JSON.stringify(imageGenerationToDto({ record }))));
    const restored = imageGenerationToDomain({ dto });
    expect(restored).toEqual(record);
    expect(restored.request.parameters).toMatchObject({ sampler: 'auto', scheduler: 'auto' });
    expect(restored.result.sampling).toEqual({ sampler: { id: 9, name: 'flux' }, scheduler: { id: 7 } });
    const assetDto = ExperimentalImageGenerationAssetSchemaDto.parse(JSON.parse(JSON.stringify(imageGenerationAssetToDto({ asset }))));
    expect(imageGenerationAssetToDomain({ dto: assetDto }).result.sampling).toEqual(record.result.sampling);
    expect(imageGenerationAssetToDomain({ dto: assetDto }).result.resolvedParameters).toEqual(record.result.resolvedParameters);
    expect(ExperimentalImageGenerationAssetSchemaDto.safeParse({ ...assetDto, result: { ...assetDto.result, resolvedParameters: { steps: 'auto', guidance: 1, vaeTileSize: 16 } } }).success).toBe(false);
  });

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

  it.each(futureShapes)('loads and resaves known fields while stripping future $name fields', ({ extend }) => {
    const original = imageGenerationRunToDto({ run: runFixture() });
    const parsed = ExperimentalImageGenerationRunSchemaDto.parse(extend({ dto: original }));
    expect(JSON.stringify(parsed)).not.toContain('"future"');
    expect(parsed.request).toEqual(original.request);
    expect(ExperimentalImageGenerationRunSchemaDto.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it('reads runtime records with additional fields without changing known generation settings', () => {
    const run = runFixture();
    const dto = imageGenerationRunToDto({ run });
    const parsed = ExperimentalImageGenerationRunSchemaDto.parse({ ...dto, request: { ...dto.request, runtime: { ...dto.request.runtime, future: true } } });
    expect(imageGenerationRunToDomain({ dto: parsed })).toEqual(run);
  });

  it('loads stored seed plans without recomputing or enforcing the current planner', () => {
    const dto = imageGenerationRunToDto({ run: runFixture() });
    expect(ExperimentalImageGenerationRunSchemaDto.safeParse({ ...dto, seeds: ['1', '2', '3', '4'] }).success).toBe(true);
    expect(ExperimentalImageGenerationRunSchemaDto.safeParse({ ...dto, request: { ...dto.request, parameters: { ...dto.request.parameters, seed: '-1' } } }).success).toBe(true);
  });

  it.each(['候補', 'CANDIDATE', 'ガ'])('retains duplicate or unnormalized catalog labels as saved data: %s', name => {
    const sameKeyName = name === 'CANDIDATE' ? 'candidate' : name;
    const catalog = {
      version: 1,
      id: 'store-aa',
      revision: 0,
      createdAt: 1,
      preferences: { assistantLayout: 'floating' },
      tags: [
        { id: 'tag-aa', name, createdAt: 1, updatedAt: 1, state: 'active' },
        { id: 'tag-bb', name: sameKeyName, createdAt: 1, updatedAt: 1, state: 'archived' },
      ],
    };
    expect(ExperimentalImageGenerationCatalogSchemaDto.parse(catalog).tags).toEqual(catalog.tags);
  });

  it('keeps reserved system tags structurally distinct from user identifiers', () => {
    const annotations = {
      assetId: 'asset-aa',
      sessionId: 'session-aa',
      revision: 1,
      state: 'active' as const,
      tags: [
        { tag: { type: 'system', key: 'favorite' }, assignedAt: 1 },
        { tag: { type: 'user', tagId: 'favorite' }, assignedAt: 2 },
      ],
    };
    expect(ExperimentalImageGenerationAssetAnnotationsSchemaDto.parse(annotations).tags).toHaveLength(2);
    expect(ExperimentalImageGenerationAssetAnnotationsSchemaDto.safeParse({ ...annotations, tags: [{ tag: { type: 'system', key: 'custom' }, assignedAt: 1 }] }).success).toBe(false);
  });
});

describe('legacy request mapper reuse', () => {
  it('does not change existing single-image history mapping', () => {
    const run = runFixture();
    const asset = generationAssetFixture({ id: 'asset-aa', run, index: 0 });
    const record = { id: toImageGenerationId({ raw: 'legacy-aa' }), createdAt: run.createdAt, request: run.request, result: asset.result, previews: asset.previews };
    expect(imageGenerationToDomain({ dto: imageGenerationToDto({ record }) })).toEqual(record);
    expect(imageGenerationRequestToDomain({ request: imageGenerationRequestToDto({ request: run.request }) })).toEqual(run.request);
  });
});

describe('experimental presentation preferences', () => {
  it('loads future preference keys and numeric values without blanket rejection', () => {
    const raw = {
      version: 1,
      id: 'catalog-aa',
      revision: 1,
      createdAt: 1,
      tags: [],
      preferences: {
        assistantLayout: 'docked',
        experimentalNoticeDismissedAt: -1,
        unrecognizedPreference: true,
      },
    };
    const parsed = ExperimentalImageGenerationCatalogSchemaDto.parse(raw);
    expect(parsed.preferences.assistantLayout).toBe('docked');
    expect(parsed.preferences.experimentalNoticeDismissedAt).toBe(-1);
    expect(parsed.preferences).not.toHaveProperty('unrecognizedPreference');
  });

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
    { assistantLayout: 'docked', experimentalNoticeDismissedAt: '2' },
    { assistantLayout: 'docked', experimentalNoticeDismissedAt: Number.POSITIVE_INFINITY },
  ])('rejects wrong field types and unknown discriminators: %j', preferences => {
    expect(ExperimentalImageGenerationCatalogSchemaDto.safeParse({ version: 1, id: 'catalog-aa', revision: 1, createdAt: 1, tags: [], preferences }).success).toBe(false);
  });
});
