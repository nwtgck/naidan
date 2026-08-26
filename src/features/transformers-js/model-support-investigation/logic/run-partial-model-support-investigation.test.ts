import { describe, expect, it, vi } from 'vitest';
import type {
  ModelSupportInvestigationCacheProvenance,
  ModelSupportInvestigationRun,
} from '@/features/transformers-js/model-support-investigation/types';
import { runPartialModelSupportInvestigation } from './run-partial-model-support-investigation';

function cacheProvenance({ resolvedRevision = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }: {
  resolvedRevision?: string,
} = {}): ModelSupportInvestigationCacheProvenance {
  return {
    schemaVersion: 1,
    method: 'bounded-range-sha256-v1',
    resolvedRevision,
    rangeBytes: 32 * 1024,
    maximumFileCount: 3,
    status: 'not-observed',
    confidence: 'none',
    files: [],
    reason: 'No exact-revision files were eligible',
  };
}

function runtimeRun(): ModelSupportInvestigationRun {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    modelId: 'hf.co/org/model',
    scope: 'partial-runtime-preflight',
    startedAt: '2026-08-06T00:00:00.000Z',
    completedAt: '2026-08-06T00:00:01.000Z',
    status: 'passed',
    currentOperation: 'runtime passed',
    steps: [
      { id: 'runtime-assets', status: 'passed', detail: 'runtime passed' },
      { id: 'repository-information', status: 'not-run', detail: undefined },
      { id: 'existing-model-data', status: 'not-run', detail: undefined },
      { id: 'model-declarations', status: 'not-run', detail: undefined },
      { id: 'template-behavior', status: 'not-run', detail: undefined },
      { id: 'model-file-plan', status: 'not-run', detail: undefined },
      { id: 'loading-investigation', status: 'not-run', detail: undefined },
      { id: 'lane-comparison', status: 'not-run', detail: undefined },
      { id: 'evidence-export', status: 'not-run', detail: undefined },
    ],
    runtimeAssets: undefined,
    repository: undefined,
    cache: undefined,
    declarations: undefined,
    templateBehavior: undefined,
    modelFilePlan: undefined,
    loadAttempts: [],
    productionLane: { status: 'not-run', observation: undefined, error: undefined },
    laneComparison: undefined,
    error: undefined,
  };
}

describe('runPartialModelSupportInvestigation', () => {

  it('collects resolved declarations and public Auto class evidence after repository and cache inspection', async () => {
    const repository = {
      requestedModelId: 'hf.co/org/model',
      normalizedModelId: 'org/model',
      requestedRevision: 'main' as const,
      resolvedRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      apiUrl: 'https://huggingface.co/api/models/org/model/revision/main?blobs=true',
      responseUrl: 'https://huggingface.co/api/models/org/model/revision/main?blobs=true',
      fileCount: 1,
      files: [],
      pipelineTag: 'text-generation',
      libraryName: 'transformers',
      metadata: {},
    };
    const inspectDeclarations = vi.fn().mockResolvedValue({
      normalizedModelId: 'org/model',
      resolvedRevision: repository.resolvedRevision,
      files: [],
      config: { model_type: 'new_chat_model' },
      modelType: 'new_chat_model',
      architectures: ['NewChatForCausalLM'],
      autoMap: undefined,
      transformersJsConfig: undefined,
      classCapabilities: [{
        autoClass: 'AutoModelForCausalLM',
        supports: true,
        notEvaluatedReason: undefined,
      }],
    });
    const inspectTemplateBehavior = vi.fn().mockResolvedValue({
      normalizedModelId: 'org/model',
      resolvedRevision: repository.resolvedRevision,
      tokenizerClass: 'ProbeTokenizer',
      declaredChatTemplate: '{{ messages }}',
      cases: [{
        caseId: 'user-generation',
        messages: [{ role: 'user', content: 'Template probe user message.' }],
        tools: undefined,
        addGenerationPrompt: true,
        status: 'passed',
        selectedTemplate: '{{ messages }}',
        renderedText: 'rendered',
        inputIds: [1, 2],
        failureStage: undefined,
        error: undefined,
      }],
    });
    const inspectModelFilePlan = vi.fn().mockResolvedValue({
      normalizedModelId: 'org/model',
      resolvedRevision: repository.resolvedRevision,
      modelType: 'new_chat_model',
      registrySource: 'ModelRegistry.get_model_files',
      cacheRevisionProvenance: 'unknown',
      cacheRevisionProvenanceReason: 'The cache path records a requested revision segment, but completion markers do not independently verify file bytes against the resolved Hugging Face commit SHA',
      candidates: [{
        candidateId: 'webgpu-q4',
        device: 'webgpu',
        dtype: 'q4',
        registryStatus: 'planned',
        registryError: undefined,
        registryReturnedFileCount: 2,
        duplicatePaths: [],
        files: [],
        requiredFileCount: 2,
        optionalFileCount: 0,
        missingRequiredFileCount: 0,
        zeroByteRequiredFileCount: 0,
        missingOptionalFileCount: 0,
        cacheObservedRequiredFileCount: 0,
        cacheCompleteMarkerRequiredFileCount: 0,
        eligibility: 'eligible',
        ineligibleReasons: [],
      }],
    });
    const events: unknown[] = [];
    const verifyCacheProvenance = vi.fn().mockResolvedValue(cacheProvenance());

    const result = await runPartialModelSupportInvestigation({
      runRuntimePreflight: async () => runtimeRun(),
      inspectRepository: async () => repository,
      inspectCache: async () => ({
        normalizedModelId: 'org/model',
        rootPath: 'models/huggingface.co/org/model',
        exists: true,
        revisionProvenance: 'unknown',
        revisionProvenanceReason: 'The cache path records a requested revision segment, but completion markers do not independently verify file bytes against the resolved Hugging Face commit SHA',
        totalBytes: 0,
        fileCount: 0,
        completionMarkerCount: 0,
        incompleteFileCount: 0,
        orphanCompletionMarkerCount: 0,
        orphanCompletionMarkerPaths: [],
        zeroByteFileCount: 0,
        weightFileCount: 0,
        allFilesHaveCompletionMarkers: false,
        files: [],
      }),
      verifyCacheProvenance,
      inspectDeclarations,
      inspectTemplateBehavior,
      inspectModelFilePlan,
      onEvent: ({ event }) => events.push(event),
      now: () => '2026-08-06T00:00:02.000Z',
    });

    expect(result.status).toBe('passed');
    expect(result.scope).toBe('partial-runtime-repository-cache-declarations-template-model-files');
    expect(result.declarations?.modelType).toBe('new_chat_model');
    expect(result.steps.find(step => step.id === 'model-declarations')).toMatchObject({
      status: 'passed',
      detail: 'new_chat_model: 1 public Auto classes support this model type',
    });
    expect(verifyCacheProvenance).toHaveBeenCalledWith({ repository, cache: result.cache });
    expect(result.cache?.provenance).toEqual(cacheProvenance());
    expect(inspectDeclarations).toHaveBeenCalledWith({ repository });
    expect(inspectTemplateBehavior).toHaveBeenCalledWith({ repository });
    expect(inspectModelFilePlan).toHaveBeenCalledWith({
      repository,
      declarations: expect.objectContaining({ modelType: 'new_chat_model' }),
      cache: result.cache,
    });
    expect(result.templateBehavior?.tokenizerClass).toBe('ProbeTokenizer');
    expect(events).toHaveLength(10);
  });
  it('keeps cache evidence when repository inspection fails', async () => {
    const events: unknown[] = [];
    const inspectDeclarations = vi.fn();
    const inspectTemplateBehavior = vi.fn();
    const inspectModelFilePlan = vi.fn();
    const result = await runPartialModelSupportInvestigation({
      runRuntimePreflight: async () => runtimeRun(),
      inspectRepository: async () => {
        throw new Error('repository unavailable');
      },
      inspectCache: async () => ({
        normalizedModelId: 'org/model',
        rootPath: 'models/huggingface.co/org/model',
        exists: true,
        revisionProvenance: 'unknown',
        revisionProvenanceReason: 'The cache path records a requested revision segment, but completion markers do not independently verify file bytes against the resolved Hugging Face commit SHA',
        totalBytes: 10,
        fileCount: 1,
        completionMarkerCount: 1,
        incompleteFileCount: 0,
        orphanCompletionMarkerCount: 0,
        orphanCompletionMarkerPaths: [],
        zeroByteFileCount: 0,
        weightFileCount: 1,
        allFilesHaveCompletionMarkers: true,
        files: [],
      }),
      verifyCacheProvenance: async () => cacheProvenance(),
      inspectDeclarations,
      inspectTemplateBehavior,
      inspectModelFilePlan,
      onEvent: ({ event }) => events.push(event),
      now: () => '2026-08-06T00:00:02.000Z',
    });

    expect(result.status).toBe('failed');
    expect(result.repository).toBeUndefined();
    expect(result.cache?.exists).toBe(true);
    expect(result.steps.find(step => step.id === 'repository-information')?.status).toBe('failed');
    expect(result.steps.find(step => step.id === 'existing-model-data')?.status).toBe('passed');
    expect(result.steps.find(step => step.id === 'model-declarations')?.status).toBe('blocked');
    expect(result.steps.find(step => step.id === 'template-behavior')?.status).toBe('blocked');
    expect(result.steps.find(step => step.id === 'model-file-plan')?.status).toBe('blocked');
    expect(inspectDeclarations).not.toHaveBeenCalled();
    expect(inspectTemplateBehavior).not.toHaveBeenCalled();
    expect(inspectModelFilePlan).not.toHaveBeenCalled();
    expect(inspectModelFilePlan).not.toHaveBeenCalled();
    expect(events).toHaveLength(7);
  });

  it('does not inspect repository or cache after a runtime integrity failure', async () => {
    const failed = runtimeRun();
    failed.status = 'failed';
    const inspectRepository = vi.fn();
    const inspectCache = vi.fn();
    const inspectDeclarations = vi.fn();
    const inspectTemplateBehavior = vi.fn();
    const inspectModelFilePlan = vi.fn();

    const result = await runPartialModelSupportInvestigation({
      runRuntimePreflight: async () => failed,
      inspectRepository,
      inspectCache,
      verifyCacheProvenance: async () => cacheProvenance(),
      inspectDeclarations,
      inspectTemplateBehavior,
      inspectModelFilePlan,
      onEvent: vi.fn(),
      now: () => '2026-08-06T00:00:02.000Z',
    });

    expect(result.scope).toBe('partial-runtime-repository-cache-declarations-template-model-files');
    expect(inspectRepository).not.toHaveBeenCalled();
    expect(inspectCache).not.toHaveBeenCalled();
    expect(inspectDeclarations).not.toHaveBeenCalled();
    expect(inspectTemplateBehavior).not.toHaveBeenCalled();
  });
});
