import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { flushPromises, mount } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { toToolCallId } from '@/01-models/ids';
import ModelSupportInvestigationModal from './ModelSupportInvestigationModal.vue';
import { configurationForPreset } from '@/features/transformers-js/model-support-investigation/logic/investigation-config';
import { TEST_ONLY as sessionTestOnly } from '@/features/transformers-js/model-support-investigation/logic/investigation-session';
import { createInitialInvestigationCheckpoint } from '@/features/transformers-js/model-support-investigation/logic/investigation-recovery';
import type { ModelSupportInvestigationRun, ModelSupportInvestigationWorkerClient } from '@/features/transformers-js/model-support-investigation/types';

const fixtureToolCallId = toToolCallId({ raw: 'call_fixture' });

const workerMocks = vi.hoisted(() => ({
  runPartialInvestigation: vi.fn(),
  interrupt: vi.fn(),
  dispose: vi.fn(),
}));

const evidenceMocks = vi.hoisted(() => ({
  createPartialEvidence: vi.fn(),
  createBatchEvidence: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock('@/features/transformers-js/model-support-investigation/worker/client-hosted', () => ({
  createModelSupportInvestigationWorkerClient: () => workerMocks,
}));

vi.mock('@/features/transformers-js/model-support-investigation/evidence-worker/client-hosted', () => ({
  createModelSupportInvestigationEvidenceWorkerClient: () => evidenceMocks,
}));

const completedRun: ModelSupportInvestigationRun = {
  schemaVersion: 1,
  runId: 'run-1',
  modelId: 'hf.co/org/model',
  scope: 'partial-runtime-repository-cache-declarations-template-model-files-load-lanes',
  startedAt: '2026-08-06T00:00:00.000Z',
  completedAt: '2026-08-06T00:00:01.000Z',
  status: 'passed',
  currentOperation: 'Same-origin ONNX Runtime module, WASM, and control inference verified',
  steps: [
    { id: 'runtime-assets', status: 'passed', detail: 'Same-origin ONNX Runtime module, WASM, and control inference verified' },
    { id: 'repository-information', status: 'passed', detail: 'Resolved repository metadata' },
    { id: 'existing-model-data', status: 'passed', detail: 'Inspected OPFS inventory' },
    { id: 'model-declarations', status: 'passed', detail: 'new_chat_model: 1 public Auto classes support this model type' },
    { id: 'template-behavior', status: 'passed', detail: 'ProbeTokenizer: 1 template cases rendered, 0 recorded as unsupported or failed' },
    { id: 'model-file-plan', status: 'passed', detail: '1 of 3 fixed candidates have all required repository files; 0 Registry failures' },
    { id: 'loading-investigation', status: 'passed', detail: 'webgpu-q4 loaded and generated 1 token' },
    { id: 'lane-comparison', status: 'passed', detail: 'Reference and Production input tokens match exactly' },
    { id: 'evidence-export', status: 'not-run', detail: undefined },
  ],
  runtimeAssets: {
    variant: 'asyncify',
    baseUrl: 'https://naidan.example/app/transformers/',
    mjsUrl: 'https://naidan.example/app/transformers/ort-wasm-simd-threaded.asyncify.mjs',
    wasmUrl: 'https://naidan.example/app/transformers/ort-wasm-simd-threaded.asyncify.wasm',
    wasmByteLength: 4,
    mjsOrigin: 'https://naidan.example',
    wasmOrigin: 'https://naidan.example',
    applicationOrigin: 'https://naidan.example',
    environment: {
      userAgent: 'Browser/1',
      vendor: 'Vendor',
      hardwareConcurrency: 8,
      deviceMemoryGiB: 16,
      crossOriginIsolated: true,
      webGpu: {
        availability: 'available',
        adapterInfo: { vendor: 'GPU Vendor' },
        features: ['shader-f16'],
        limits: { maxBufferSize: 1024 },
        error: undefined,
      },
    },
    threading: {
      requestedThreads: 4,
      effectiveThreads: 1,
      effectiveThreadsBasis: 'runtime-env-after-control',
      proxy: false,
      childWorkerLifecycle: 'not-observed',
      childWorkerLifecycleReason: 'Emscripten pthread worker lifecycle is not exposed by the public runtime API',
    },
    control: {
      fixtureId: 'identity-float32-v1',
      fixtureSha256: '19be871867d45a5bb90b850518b38262a67d14cfccc147f6566f15308c273443',
      executionProvider: 'wasm',
      status: 'passed',
      inputName: 'x',
      outputName: 'y',
      inputValue: 7,
      outputValue: 7,
      error: undefined,
    },
    webGpuControl: {
      fixtureId: 'identity-float32-v1',
      fixtureSha256: '19be871867d45a5bb90b850518b38262a67d14cfccc147f6566f15308c273443',
      executionProvider: 'webgpu',
      status: 'passed',
      inputName: 'x',
      outputName: 'y',
      inputValue: 7,
      outputValue: 7,
      error: undefined,
    },
  },
  repository: {
    requestedModelId: 'hf.co/org/model',
    normalizedModelId: 'org/model',
    requestedRevision: 'main',
    resolvedRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    apiUrl: 'https://huggingface.co/api/models/org/model/revision/main?blobs=true',
    responseUrl: 'https://huggingface.co/api/models/org/model/revision/main?blobs=true',
    fileCount: 3,
    files: [],
    pipelineTag: 'text-generation',
    libraryName: 'transformers',
    metadata: {},
  },
  runtimeTarget: {
    normalizedModelId: 'org/model',
    evidenceRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    loaderRevisionOption: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    source: 'repository',
    revisionIdentity: 'exact-resolved-revision',
    pipelineTag: 'text-generation',
  },
  downloadEvidence: undefined,
  cache: {
    normalizedModelId: 'org/model',
    rootPath: 'models/huggingface.co/org/model',
    exists: true,
    revisionProvenance: 'unknown',
    revisionProvenanceReason: 'The cache path records a requested revision segment, but completion markers do not independently verify file bytes against the resolved Hugging Face commit SHA',
    totalBytes: 30,
    fileCount: 1,
    completionMarkerCount: 1,
    incompleteFileCount: 0,
    orphanCompletionMarkerCount: 0,
    orphanCompletionMarkerPaths: [],
    zeroByteFileCount: 0,
    weightFileCount: 1,
    allFilesHaveCompletionMarkers: true,
    files: [],
  },
  declarations: {
    normalizedModelId: 'org/model',
    resolvedRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    files: [{
      path: 'config.json',
      url: 'https://huggingface.co/org/model/resolve/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/config.json',
      responseUrl: 'https://huggingface.co/org/model/resolve/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/config.json',
      byteLength: 100,
      contentType: 'application/json',
      value: { model_type: 'new_chat_model' },
    }],
    fileFailures: [],
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
  },
  templateBehavior: {
    normalizedModelId: 'org/model',
    resolvedRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
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
    toolTemplateProvenance: {
      status: 'observed',
      source: 'chat-template-render',
      generationCaseId: 'tools-generation',
      assistantToolCallCaseId: 'assistant-tool-call-history',
      toolResultContinuationCaseId: 'tool-result-continuation',
      generationInputIds: [1, 2],
      assistantToolCallInputIds: [1, 2, 3, 4],
      toolResultContinuationInputIds: [1, 2, 3, 4],
      generationPromptPrefixMatch: true,
      firstMismatchIndex: undefined,
      assistantToolCallSuffixTokenIds: [3, 4],
    },
  },
  modelFilePlan: {
    normalizedModelId: 'org/model',
    resolvedRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
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
      cacheObservedRequiredFileCount: 1,
      cacheCompleteMarkerRequiredFileCount: 1,
      eligibility: 'eligible',
      ineligibleReasons: [],
    }],
  },
  loadAttempts: [{
    attemptId: 'attempt-1',
    candidateId: 'webgpu-q4',
    device: 'webgpu',
    dtype: 'q4',
    autoClass: 'AutoModelForCausalLM',
    resolvedRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    startedAt: '2026-08-06T00:00:00.500Z',
    completedAt: '2026-08-06T00:00:00.900Z',
    status: 'passed',
    failureStage: undefined,
    events: [],
    inputStrategyAttempts: [],
    selectedInputStrategy: undefined,
    inputTokenCount: 2,
    inputTokenIds: [1, 2],
    inputTensors: [],
    loadedModel: undefined,
    generatedTokenIds: [42],
    generatedText: 'answer',
    naturalGeneration: {
      status: "observed",
      forced: false,
      maxNewTokens: 16,
      doSample: false,
      generatedTokenIds: [43, 44],
      generatedText: 'natural',
      termination: 'ended-before-limit',
    },
    toolProtocolProbe: {
      status: 'observed',
      forced: true,
      source: 'chat-template-render',
      generationCaseId: 'tools-generation',
      assistantToolCallCaseId: 'assistant-tool-call-history',
      toolResultContinuationCaseId: 'tool-result-continuation',
      inputTokenIds: [1, 2],
      forcedTokenIds: [3, 4],
      generatedTokenIds: [3, 4],
      generatedText: 'tool call',
      exactMatch: true,
      firstMismatchIndex: undefined,
      termination: 'complete-forced-sequence',
      parserObservation: {
        status: 'observed',
        strategy: 'standard',
        parserKind: 'standard-tool-call-stream-parser',
        inputMode: 'production-text-streamer-reconstruction',
        inputChunks: ['<tool_call>{\'name\':\'lookup_weather\',\'arguments\':{}}</tool_call>'],
        visibleText: '',
        callBoundaryCount: undefined,
        toolCalls: [{ name: 'lookup_weather', arguments: '{}' }],
        recognized: true,
      },
      toolResultTemplateRoundTrip: {
        status: 'observed',
        source: 'recognized-production-parser-and-chat-template',
        parserStrategy: 'standard',
        toolCall: { name: 'lookup_weather', arguments: '{}' },
        toolResultContent: '{"temperatureC":20,"condition":"clear"}',
        selectedTemplate: 'tool template',
        renderedText: 'tool result continuation',
        inputTokenIds: [1, 2, 3],
      },
    },
    modelType: 'new_chat_model',
    error: undefined,
  }],
  productionLane: {
    status: 'passed',
    observation: {
      modelId: 'org/model',
      resolvedRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      candidate: { device: 'webgpu', dtype: 'q4' },
      loadAttempts: [
        { candidate: { device: 'webgpu', dtype: 'q4f16' }, status: 'failed', error: { name: 'Error', message: 'q4f16 load failed', stack: 'stack-q4f16' } },
        { candidate: { device: 'webgpu', dtype: 'q4' }, status: 'passed', error: undefined },
      ],
      route: {
        autoClass: 'AutoModelForCausalLM',
        processor: 'tokenizer',
        strategy: 'standard',
        modelType: 'new_chat_model',
      },
      isEncoderDecoder: false,
      firstTurn: {
        status: "passed",
        turn: {
          messages: [{ role: 'user', content: 'Template probe user message.' }],
          inputKeys: ['input_ids'],
          inputTensors: [],
          inputTokenIds: [1, 2],
          fullConversationInput: { status: 'unavailable', reason: 'test fixture does not observe reconstructed full conversation input' },
          cacheDecision: { status: 'unavailable', reason: 'test fixture does not observe cache decision' },
          pastKeyValuesProvided: false,
          inputPastKeyValuesSummary: { kind: 'nullish', valueType: 'undefined', constructorName: undefined, ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
          outputPastKeyValuesSummary: { kind: 'object', valueType: 'object', constructorName: 'Object', ownKeyCount: 1, ownKeys: ['layer_0'], arrayLength: undefined, truncated: false },
          generatedSequenceTokenIds: [1, 2, 45],
          generatedTokenIds: [45],
          generatedText: 'production',
          streamChunks: ['production'],
          toolCalls: [],
          effectiveGenerationConfig: { maxNewTokens: 16, temperature: 0, topP: 1, doSample: false },
        },
      },
      continuity: {
        status: 'failed',
        assistantMessage: { role: 'assistant', content: 'production' },
        followUpMessage: { role: 'user', content: 'Continue with one short sentence.' },
        error: { name: 'FixtureContinuityError', message: 'fixture second turn failed' },
      },
      toolResultContinuation: {
        status: 'passed',
        source: 'reference-parser-roundtrip',
        strategy: 'standard',
        messages: [
          { role: 'user', content: 'Look up the weather.' },
          { role: 'assistant', content: '', tool_calls: [{ id: fixtureToolCallId, type: 'function', function: { name: 'lookup_weather', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: fixtureToolCallId, content: '{"temperatureC":20,"condition":"clear"}' },
        ],
        expectedInputTokenIds: [50, 51, 52],
        comparisonInputSource: 'reconstructed-full-conversation',
        inputTokenExactMatch: true,
        firstInputMismatchIndex: undefined,
        turn: {
          messages: [],
          inputKeys: ['input_ids'],
          inputTensors: [],
          inputTokenIds: [50, 51, 52],
          fullConversationInput: { status: 'unavailable', reason: 'test fixture does not observe reconstructed full conversation input' },
          cacheDecision: { status: 'unavailable', reason: 'test fixture does not observe cache decision' },
          pastKeyValuesProvided: false,
          inputPastKeyValuesSummary: { kind: 'nullish', valueType: 'undefined', constructorName: undefined, ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
          outputPastKeyValuesSummary: { kind: 'object', valueType: 'object', constructorName: 'Object', ownKeyCount: 1, ownKeys: ['layer_0'], arrayLength: undefined, truncated: false },
          generatedSequenceTokenIds: [50, 51, 52, 60],
          generatedTokenIds: [60],
          generatedText: 'continued',
          streamChunks: ['continued'],
          toolCalls: [],
          effectiveGenerationConfig: { maxNewTokens: 16, temperature: 0, topP: 1, doSample: false },
        },
      },
      reasoning: {
        status: 'observed',
        source: 'existing-production-strategy',
        strategy: 'qwen3_5',
        disabledEffort: 'none',
        enabledEffort: 'high',
        disabledTurn: {
          messages: [], inputKeys: ['input_ids'], inputTensors: [], inputTokenIds: [70, 0], fullConversationInput: { status: 'unavailable', reason: 'test fixture does not observe reconstructed full conversation input' }, cacheDecision: { status: 'unavailable', reason: 'test fixture does not observe cache decision' }, pastKeyValuesProvided: false,
          inputPastKeyValuesSummary: { kind: 'nullish', valueType: 'undefined', constructorName: undefined, ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
          outputPastKeyValuesSummary: { kind: 'nullish', valueType: 'undefined', constructorName: undefined, ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
          generatedSequenceTokenIds: [70, 0, 80], generatedTokenIds: [80], generatedText: 'none', streamChunks: ['none'], toolCalls: [],
          effectiveGenerationConfig: { maxNewTokens: 16, temperature: 0, topP: 1, doSample: false },
        },
        enabledTurn: {
          messages: [], inputKeys: ['input_ids'], inputTensors: [], inputTokenIds: [70, 1], fullConversationInput: { status: 'unavailable', reason: 'test fixture does not observe reconstructed full conversation input' }, cacheDecision: { status: 'unavailable', reason: 'test fixture does not observe cache decision' }, pastKeyValuesProvided: false,
          inputPastKeyValuesSummary: { kind: 'nullish', valueType: 'undefined', constructorName: undefined, ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
          outputPastKeyValuesSummary: { kind: 'nullish', valueType: 'undefined', constructorName: undefined, ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
          generatedSequenceTokenIds: [70, 1, 81], generatedTokenIds: [81], generatedText: 'high', streamChunks: ['high'], toolCalls: [],
          effectiveGenerationConfig: { maxNewTokens: 16, temperature: 0, topP: 1, doSample: false },
        },
        inputTokenExactMatch: false,
        firstInputMismatchIndex: 1,
      },
      multimodal: {
        status: 'observed',
        source: 'fixed-synthetic-fixture-and-existing-production-strategy',
        strategy: 'gemma4',
        fixture: {
          fixtureId: 'single-transparent-pixel-png-v1',
          sha256: '431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460',
          mimeType: 'image/png',
          width: 1,
          height: 1,
          byteLength: 68,
          generationMethod: 'embedded-fixed-png-bytes',
          prompt: 'Describe the single synthetic image in one short phrase.',
          maxNewTokens: 1,
        },
        turn: {
          messages: [],
          inputKeys: ['attention_mask', 'input_ids', 'pixel_values'],
          inputTensors: [
            { name: 'attention_mask', dtype: 'int64', dims: [1, 2], location: 'cpu' },
            { name: 'input_ids', dtype: 'int64', dims: [1, 2], location: 'cpu' },
            { name: 'pixel_values', dtype: 'float32', dims: [1, 3, 1, 1], location: 'gpu-buffer' },
          ],
          inputTokenIds: [7, 8],
          fullConversationInput: { status: 'unavailable', reason: 'test fixture does not observe reconstructed full conversation input' },
          cacheDecision: { status: 'unavailable', reason: 'test fixture does not observe cache decision' },
          pastKeyValuesProvided: false,
          inputPastKeyValuesSummary: { kind: 'nullish', valueType: 'undefined', constructorName: undefined, ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
          outputPastKeyValuesSummary: { kind: 'object', valueType: 'object', constructorName: 'Object', ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
          generatedSequenceTokenIds: [7, 8, 99],
          generatedTokenIds: [99],
          generatedText: 'image',
          streamChunks: ['image'],
          toolCalls: [],
          effectiveGenerationConfig: { maxNewTokens: 1, temperature: 0, topP: 1, doSample: false },
        },
      },
    },
    error: undefined,
  },
  laneComparison: {
    scenarioCaseId: 'user-generation',
    referenceAttemptId: 'attempt-1',
    exactInputMatch: true,
    firstInputMismatchIndex: undefined,
    referenceInputTokenIds: [1, 2],
    productionInputTokenIds: [1, 2],
    referenceGeneratedTokenIds: [42],
    productionGeneratedTokenIds: [45],
    productionRoute: {
      autoClass: 'AutoModelForCausalLM',
      processor: 'tokenizer',
      strategy: 'standard',
      modelType: 'new_chat_model',
    },
  },
  error: undefined,
};

describe('ModelSupportInvestigationModal', () => {
  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
  });

  beforeEach(() => {
    sessionTestOnly.clear();
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn() },
    });
    workerMocks.runPartialInvestigation.mockImplementation(async ({ onEvent }) => {
      onEvent({
        event: {
          stepId: 'runtime-assets',
          status: 'passed',
          detail: 'Same-origin ONNX Runtime module, WASM, and control inference verified',
        },
      });
      return completedRun;
    });
    workerMocks.dispose.mockResolvedValue(undefined);
    workerMocks.interrupt.mockResolvedValue(undefined);
    evidenceMocks.createPartialEvidence.mockResolvedValue({
      blob: new Blob(["evidence"]),
      fileName: "evidence.zip",
    });
    evidenceMocks.createBatchEvidence.mockResolvedValue({
      blob: new Blob(["batch-evidence"]),
      fileName: "batch-evidence.zip",
    });
    evidenceMocks.dispose.mockResolvedValue(undefined);
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:evidence"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reopens completed results and exports retained metadata without rerunning the investigation', async () => {
    // jsdom Blobs are not supported by Node's native structuredClone.
    vi.stubGlobal('Blob', NodeBlob);
    const sidecar = { path: 'tokenizer.json', blob: new Blob(['{"version":"1.0"}']) };
    workerMocks.runPartialInvestigation.mockImplementation(async ({ onCheckpoint }: Parameters<ModelSupportInvestigationWorkerClient['runPartialInvestigation']>[0]) => {
      const checkpoint = createInitialInvestigationCheckpoint({ modelId: completedRun.modelId, runId: completedRun.runId, now: () => completedRun.startedAt });
      onCheckpoint?.({ checkpoint: { ...checkpoint, run: completedRun, replayMetadata: [sidecar] } });
      return completedRun;
    });
    const first = mount(ModelSupportInvestigationModal, { props: { modelId: 'hf.co/org/model' } });
    await first.get('[data-testid="model-support-investigation-start"]').trigger('click');
    await flushPromises();
    first.unmount();
    const reopened = mount(ModelSupportInvestigationModal, { props: { modelId: 'hf.co/org/model' } });
    await flushPromises();
    expect(workerMocks.runPartialInvestigation).toHaveBeenCalledOnce();
    await reopened.get('[data-testid="model-support-investigation-download"]').trigger('click');
    await flushPromises();
    const exported = evidenceMocks.createPartialEvidence.mock.calls[0]?.[0];
    expect(exported.run.runId).toBe(completedRun.runId);
    expect(exported.replayMetadata[0].path).toBe('tokenizer.json');
    expect(await exported.replayMetadata[0].blob.text()).toBe('{"version":"1.0"}');
    reopened.unmount();
  });

  it('selects the requested model when reopening a retained multi-model batch', async () => {
    workerMocks.runPartialInvestigation.mockImplementation(async ({ modelId }: Parameters<ModelSupportInvestigationWorkerClient['runPartialInvestigation']>[0]) => ({
      ...structuredClone(completedRun), modelId, currentOperation: `${modelId} complete`,
    }));
    const first = mount(ModelSupportInvestigationModal, { props: { modelId: '' } });
    await first.get('[data-testid="model-support-targets-input"]').setValue(`\
org/first
org/second
`);
    await first.get('[data-testid="model-support-investigation-start"]').trigger('click');
    await flushPromises();
    first.unmount();
    const reopened = mount(ModelSupportInvestigationModal, { props: { modelId: 'org/first' } });
    await flushPromises();
    expect(reopened.get('[data-testid="model-support-current-operation"]').text()).toBe('org/first complete');
    expect(workerMocks.runPartialInvestigation).toHaveBeenCalledTimes(2);
    reopened.unmount();
  });

  it('freezes checkpoint identity and metadata together before asynchronous export preparation', async () => {
    vi.stubGlobal('Blob', NodeBlob);
    let publish: Parameters<ModelSupportInvestigationWorkerClient['runPartialInvestigation']>[0]['onCheckpoint'] | undefined;
    const checkpoint = createInitialInvestigationCheckpoint({ modelId: 'org/model', runId: 'before-export', now: () => completedRun.startedAt });
    workerMocks.runPartialInvestigation.mockImplementation(({ onCheckpoint }: Parameters<ModelSupportInvestigationWorkerClient['runPartialInvestigation']>[0]) => {
      publish = onCheckpoint;
      publish?.({ checkpoint: { ...checkpoint, replayMetadata: [{ path: 'config.json', blob: new Blob(['{"version":1}']) }] } });
      return new Promise(() => undefined);
    });
    const wrapper = mount(ModelSupportInvestigationModal, { props: { modelId: 'org/model' } });
    await wrapper.get('[data-testid="model-support-investigation-start"]').trigger('click');
    await flushPromises();
    const exporting = wrapper.get('[data-testid="model-support-investigation-download"]').trigger('click');
    publish?.({ checkpoint: {
      ...checkpoint,
      run: { ...checkpoint.run, runId: 'after-export' },
      recovery: { ...checkpoint.recovery, checkpointSequence: 99 },
      replayMetadata: [{ path: 'config.json', blob: new Blob(['{"version":2}']) }],
    } });
    await exporting;
    await flushPromises();
    const exported = evidenceMocks.createPartialEvidence.mock.calls[0]?.[0];
    expect(exported.run.runId).toBe('before-export');
    expect(exported.recovery.checkpointSequence).toBe(0);
    expect(await exported.replayMetadata[0].blob.text()).toBe('{"version":1}');
    wrapper.unmount();
  });

  it('retains an interrupted checkpoint on teardown without restarting it when reopened', async () => {
    workerMocks.runPartialInvestigation.mockImplementation(({ onCheckpoint }: Parameters<ModelSupportInvestigationWorkerClient['runPartialInvestigation']>[0]) => {
      onCheckpoint?.({ checkpoint: createInitialInvestigationCheckpoint({ modelId: 'org/model', runId: 'pending-run', now: () => completedRun.startedAt }) });
      return new Promise(() => undefined);
    });
    const first = mount(ModelSupportInvestigationModal, { props: { modelId: 'org/model' } });
    await first.get('[data-testid="model-support-investigation-start"]').trigger('click');
    await flushPromises();
    first.unmount();
    const reopened = mount(ModelSupportInvestigationModal, { props: { modelId: 'org/model' } });
    await flushPromises();
    expect(workerMocks.runPartialInvestigation).toHaveBeenCalledOnce();
    await reopened.get('[data-testid="model-support-investigation-download"]').trigger('click');
    await flushPromises();
    expect(evidenceMocks.createPartialEvidence.mock.calls[0]?.[0]).toMatchObject({
      run: { status: 'failed', runId: 'pending-run' },
      recovery: { status: 'interrupted', interruption: { error: { message: 'Investigation stopped when its modal was closed' } } },
    });
    reopened.unmount();
  });

  it('times out a hung download investigation, continues the batch, and rejects late checkpoints', async () => {
    vi.useFakeTimers();
    let publishLate: Parameters<ModelSupportInvestigationWorkerClient['runPartialInvestigation']>[0]['onCheckpoint'] | undefined;
    workerMocks.runPartialInvestigation.mockImplementation(({ modelId, onCheckpoint }: Parameters<ModelSupportInvestigationWorkerClient['runPartialInvestigation']>[0]) => {
      if (modelId === 'org/first') {
        publishLate = onCheckpoint;
        onCheckpoint?.({ checkpoint: createInitialInvestigationCheckpoint({ modelId, runId: 'hung-run', now: () => completedRun.startedAt }) });
        return new Promise(() => undefined);
      }
      return Promise.resolve({ ...structuredClone(completedRun), modelId, runId: 'second-run' });
    });
    const wrapper = mount(ModelSupportInvestigationModal, { props: { modelId: '' } });
    await wrapper.get('[data-testid="model-support-targets-input"]').setValue(`\
org/first
org/second
`);
    await wrapper.get('[data-testid="model-support-preset-download-focused"]').trigger('click');
    await wrapper.get('[data-testid="model-support-investigation-start"]').trigger('click');
    await flushPromises();
    expect(workerMocks.runPartialInvestigation).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(120_000);
    await flushPromises();
    expect(workerMocks.runPartialInvestigation).toHaveBeenCalledTimes(2);
    publishLate?.({ checkpoint: {
      ...createInitialInvestigationCheckpoint({ modelId: 'org/first', runId: 'late-run', now: () => completedRun.startedAt }),
      run: { ...structuredClone(completedRun), modelId: 'org/first', runId: 'late-run' },
    } });
    await wrapper.get('[data-testid="model-support-investigation-download"]').trigger('click');
    await flushPromises();
    expect(evidenceMocks.createBatchEvidence.mock.calls[0]?.[0]).toMatchObject({ items: [
      { target: 'org/first', status: 'failed', run: { runId: 'hung-run', status: 'failed' }, recovery: { status: 'interrupted', interruption: { error: { name: 'InvestigationTargetBudgetError' } } } },
      { target: 'org/second', status: 'passed', run: { runId: 'second-run' } },
    ] });
    wrapper.unmount();
  });

  it.each([
    { outcome: 'passed', timeout: false, interrupted: false, collecting: false, expectedMiB: [48, 48, 48, 48, 48] },
    { outcome: 'failed', timeout: false, interrupted: false, collecting: false, expectedMiB: [48, 48, 48, 48, 48] },
    { outcome: 'failed', timeout: true, interrupted: false, collecting: false, expectedMiB: [48, 48, 48, 16, 0] },
    { outcome: 'failed', timeout: false, interrupted: true, collecting: false, expectedMiB: [48, 48, 48, 48, 48] },
    { outcome: 'failed', timeout: false, interrupted: true, collecting: true, expectedMiB: [48, 48, 48, 16, 0] },
  ] as const)('settles metadata bytes for $outcome with file timeout=$timeout, interruption=$interrupted, collecting=$collecting', async ({ outcome, timeout, interrupted, collecting, expectedMiB }) => {
    workerMocks.runPartialInvestigation.mockImplementation(async ({ modelId, onCheckpoint, replayMetadataBudgetBytes }: Parameters<ModelSupportInvestigationWorkerClient['runPartialInvestigation']>[0]) => {
      const checkpoint = createInitialInvestigationCheckpoint({ modelId, runId: `run-${modelId}`, now: () => completedRun.startedAt });
      const received = Math.min(100, replayMetadataBudgetBytes ?? 0);
      const result: ModelSupportInvestigationRun = {
        ...structuredClone(completedRun), modelId, status: outcome,
        replayMetadata: {
          schemaVersion: 1, modelId, revision: 'a'.repeat(40), status: collecting ? 'collecting' : 'partial',
          receivedBytes: received, retainedBytes: 0, budgetBytes: replayMetadataBudgetBytes ?? 0,
          files: [{ path: 'config.json', source: 'remote-exact', byteLength: received, status: timeout ? 'timeout' : 'invalid-content' }],
        },
      };
      onCheckpoint?.({ checkpoint: {
        run: result,
        recovery: { ...checkpoint.recovery, status: interrupted ? 'interrupted' : 'completed' },
      } });
      if (interrupted) throw new Error(collecting ? 'Worker lost during collection' : 'Full cache acceptance timed out after metadata collection');
      return result;
    });
    const wrapper = mount(ModelSupportInvestigationModal, { props: { modelId: '' } });
    await wrapper.get('[data-testid="model-support-targets-input"]').setValue(`\
org/one
org/two
org/three
org/four
org/five
`);
    await wrapper.get(`[data-testid="model-support-preset-${interrupted ? 'full' : 'download-focused'}"]`).trigger('click');
    await wrapper.get('[data-testid="model-support-investigation-start"]').trigger('click');
    await flushPromises();
    expect(workerMocks.runPartialInvestigation.mock.calls.map(call => call[0].replayMetadataBudgetBytes)).toEqual(expectedMiB.map(value => value * 1024 * 1024));
    wrapper.unmount();
  });

  it.each(['completed', 'interrupted'] as const)('shows %s execution independently from partial evidence coverage', async status => {
    workerMocks.runPartialInvestigation.mockImplementation(async ({ modelId, onCheckpoint }) => {
      const checkpoint = createInitialInvestigationCheckpoint({ modelId, runId: 'execution-display', now: () => completedRun.startedAt });
      const result = { ...structuredClone(completedRun), requestedConfiguration: configurationForPreset({ preset: 'download-focused' }), executionPlan: { repositoryDownload: true, modelLoad: false, generation: false, continuity: false, capabilityProbes: false } };
      onCheckpoint?.({ checkpoint: { run: result, recovery: { ...checkpoint.recovery, status } } });
      return result;
    });
    const wrapper = mount(ModelSupportInvestigationModal, { props: { modelId: 'org/model' } });
    await wrapper.get('[data-testid="model-support-investigation-start"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="model-support-execution-summary"]').text()).toContain(
      status === 'completed' ? 'Selected-scope investigation finished' : 'Investigation stopped before completion',
    );
    expect(wrapper.get('[data-testid="model-support-evidence-coverage-explanation"]').text()).toContain('not pending');
    expect(wrapper.get('[data-testid="model-support-investigation-download"]').text()).toBe('Download Evidence ZIP');
    expect(wrapper.text()).not.toContain('later investigation stages are not run yet');
    wrapper.unmount();
  });

  it('prefills the selected model without starting an investigation on mount', async () => {
    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: 'hf.co/org/model' },
    });

    expect(wrapper.get('[data-testid="model-support-target-row-org/model"]').text()).toContain('org/model');
    expect((wrapper.get('[data-testid="model-support-targets-input"]').element as HTMLTextAreaElement).value).toBe('');
    expect(workerMocks.runPartialInvestigation).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('keeps committed models above a separate input and accepts multi-line paste', async () => {
    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: 'hf.co/org/seed' },
    });

    await wrapper.get('[data-testid="model-support-targets-input"]').trigger('paste', {
      clipboardData: {
        getData: () => `\
org/one
https://hf.co/org/two
org/one`,
      },
    });
    await flushPromises();

    expect(wrapper.find('[data-testid="model-support-target-row-org/seed"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="model-support-target-row-org/one"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="model-support-target-row-org/two"]').exists()).toBe(true);
    expect((wrapper.get('[data-testid="model-support-targets-input"]').element as HTMLTextAreaElement).value).toBe('');
    expect(wrapper.findAll('[data-testid^="model-support-target-row-"]')).toHaveLength(3);
    wrapper.unmount();
  });

  it('shows the execution summary in Setup without adding a separate Review step', async () => {
    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: 'hf.co/org/model' },
    });

    expect(wrapper.get('[data-testid="model-support-stage-setup"]').attributes('data-state')).toBe('active');
    expect(wrapper.get('[data-testid="model-support-target-row-org/model"]').text()).toContain('org/model');
    expect(wrapper.get('[data-testid="model-support-investigation-start-summary"]').text()).toContain('Full');
    expect(wrapper.get('[data-testid="model-support-start-scope-model-load"]').attributes('data-state')).toBe('selected');
    expect(wrapper.find('[data-testid="model-support-investigation-review"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="model-support-stage-review"]').exists()).toBe(false);
    expect(workerMocks.runPartialInvestigation).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('validates bulk targets before starting and does not guess invalid model IDs', async () => {
    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: '' },
    });

    await wrapper.get('[data-testid="model-support-targets-input"]').setValue(`
org/first
https://hf.co/org/second
not-a-model-id
# comment
org/first
`);

    expect(wrapper.get('[data-testid="model-support-target-errors"]').text()).toContain('Invalid model on line 4.');
    expect(wrapper.get('[data-testid="model-support-investigation-start"]').attributes('disabled')).toBeDefined();
    expect(workerMocks.runPartialInvestigation).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('copies the canonical deduplicated target list', async () => {
    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: '' },
    });

    await wrapper.get('[data-testid="model-support-targets-input"]').setValue(`
org/first
https://huggingface.co/org/second
org/first
# comment
`);
    await wrapper.get('[data-testid="model-support-copy-targets"]').trigger('click');

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`\
org/first
org/second`);
    wrapper.unmount();
  });

  it('contains clipboard rejection at the Copy interaction boundary', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('clipboard denied'));
    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: 'org/model' },
    });

    await wrapper.get('[data-testid="model-support-copy-targets"]').trigger('click');
    await flushPromises();

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('org/model');
    expect(wrapper.get('[data-testid="model-support-target-row-org/model"]').text()).toContain('org/model');
    wrapper.unmount();
  });

  it('runs multiple normalized targets sequentially and keeps per-target status', async () => {
    const callOrder: string[] = [];
    workerMocks.runPartialInvestigation.mockImplementation(async ({ modelId }: Parameters<ModelSupportInvestigationWorkerClient['runPartialInvestigation']>[0]) => {
      callOrder.push(`start:${modelId}`);
      await Promise.resolve();
      callOrder.push(`finish:${modelId}`);
      return {
        ...structuredClone(completedRun),
        runId: `run-${modelId}`,
        modelId,
      };
    });
    workerMocks.dispose.mockImplementation(async () => {
      callOrder.push('dispose');
    });
    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: '' },
    });
    await wrapper.get('[data-testid="model-support-targets-input"]').setValue(`
https://hf.co/org/first
org/second
`);

    await wrapper.get('[data-testid="model-support-investigation-start"]').trigger('click');
    await flushPromises();

    expect(workerMocks.runPartialInvestigation.mock.calls.map(call => call[0].modelId)).toEqual([
      'org/first',
      'org/second',
    ]);
    expect(callOrder).toEqual([
      'start:org/first',
      'finish:org/first',
      'dispose',
      'start:org/second',
      'finish:org/second',
      'dispose',
    ]);
    expect(wrapper.get('[data-testid="model-support-target-org/first"]').attributes('data-status')).toBe('passed');
    expect(wrapper.get('[data-testid="model-support-target-org/second"]').attributes('data-status')).toBe('passed');
    wrapper.unmount();
  });

  it('stops only the current model, disposes its client, and continues with the next model', async () => {
    let rejectFirst: ((error: Error) => void) | undefined;
    const callOrder: string[] = [];
    workerMocks.runPartialInvestigation.mockImplementation(({ modelId }: Parameters<ModelSupportInvestigationWorkerClient['runPartialInvestigation']>[0]) => {
      callOrder.push(`start:${modelId}`);
      if (modelId === 'org/first') {
        return new Promise((_resolve, reject) => {
          rejectFirst = reject;
        });
      }
      return Promise.resolve({
        ...structuredClone(completedRun),
        runId: `run-${modelId}`,
        modelId,
      });
    });
    workerMocks.interrupt.mockImplementation(async () => {
      const error = new Error('Model Support Investigation was stopped by the user');
      error.name = 'ModelSupportInvestigationUserInterruptedError';
      rejectFirst?.(error);
    });
    workerMocks.dispose.mockImplementation(async () => {
      callOrder.push('dispose');
    });

    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: '' },
    });
    await wrapper.get('[data-testid="model-support-targets-input"]').setValue(`\
org/first
org/second
`);

    await wrapper.get('[data-testid="model-support-investigation-start"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="model-support-investigation-skip-current"]').exists()).toBe(true);
    await wrapper.get('[data-testid="model-support-investigation-skip-current"]').trigger('click');
    await flushPromises();

    expect(workerMocks.interrupt).toHaveBeenCalledTimes(1);
    expect(workerMocks.runPartialInvestigation.mock.calls.map(call => call[0].modelId)).toEqual([
      'org/first',
      'org/second',
    ]);
    expect(callOrder).toEqual([
      'start:org/first',
      'dispose',
      'start:org/second',
      'dispose',
    ]);
    expect(wrapper.get('[data-testid="model-support-target-org/first"]').attributes('data-status')).toBe('skipped');
    expect(wrapper.get('[data-testid="model-support-target-org/second"]').attributes('data-status')).toBe('passed');

    await wrapper.get('[data-testid="model-support-investigation-download"]').trigger('click');
    await flushPromises();
    expect(evidenceMocks.createBatchEvidence.mock.calls[0]?.[0]).toMatchObject({
      items: [
        { target: 'org/first', status: 'skipped' },
        { target: 'org/second', status: 'passed' },
      ],
    });
    wrapper.unmount();
  });

  it('exports every requested model dossier together when multiple targets were investigated', async () => {
    workerMocks.runPartialInvestigation.mockImplementation(async ({ modelId }: Parameters<ModelSupportInvestigationWorkerClient['runPartialInvestigation']>[0]) => ({
      ...structuredClone(completedRun),
      runId: `run-${modelId}`,
      modelId,
    }));
    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: '' },
    });
    await wrapper.get('[data-testid="model-support-targets-input"]').setValue(`\
org/first
org/second
`);

    await wrapper.get('[data-testid="model-support-investigation-start"]').trigger('click');
    await flushPromises();

    await wrapper.get('[data-testid="model-support-investigation-download"]').trigger('click');
    await flushPromises();

    expect(evidenceMocks.createPartialEvidence).not.toHaveBeenCalled();
    expect(evidenceMocks.createBatchEvidence).toHaveBeenCalledTimes(1);
    expect(evidenceMocks.createBatchEvidence.mock.calls[0]?.[0]).toMatchObject({
      batchId: expect.any(String),
      items: [
        {
          target: 'org/first',
          status: 'passed',
          run: { modelId: 'org/first', runId: 'run-org/first' },
          error: undefined,
        },
        {
          target: 'org/second',
          status: 'passed',
          run: { modelId: 'org/second', runId: 'run-org/second' },
          error: undefined,
        },
      ],
    });
    wrapper.unmount();
  });

  it('exports the complete target index even when every target fails before producing a run', async () => {
    workerMocks.runPartialInvestigation.mockRejectedValue(new Error('worker failed before checkpoint'));
    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: '' },
    });
    await wrapper.get('[data-testid="model-support-targets-input"]').setValue(`\
org/first
org/second
`);

    await wrapper.get('[data-testid="model-support-investigation-start"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-testid="model-support-investigation-download"]').attributes('disabled')).toBeUndefined();
    await wrapper.get('[data-testid="model-support-investigation-download"]').trigger('click');
    await flushPromises();

    expect(evidenceMocks.createPartialEvidence).not.toHaveBeenCalled();
    expect(evidenceMocks.createBatchEvidence).toHaveBeenCalledTimes(1);
    expect(evidenceMocks.createBatchEvidence.mock.calls[0]?.[0]).toMatchObject({
      batchId: expect.any(String),
      items: [
        {
          target: 'org/first',
          status: 'failed',
          run: undefined,
          recovery: undefined,
          error: 'worker failed before checkpoint',
        },
        {
          target: 'org/second',
          status: 'failed',
          run: undefined,
          recovery: undefined,
          error: 'worker failed before checkpoint',
        },
      ],
    });
    wrapper.unmount();
  });

  it('does not replace a completed target result when client disposal fails', async () => {
    workerMocks.dispose.mockRejectedValue(new Error('dispose failed'));
    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: 'hf.co/org/model' },
    });

    await wrapper.get('[data-testid="model-support-investigation-start"]').trigger('click');
    await flushPromises();

    expect(workerMocks.runPartialInvestigation).toHaveBeenCalledTimes(1);
    expect(workerMocks.dispose).toHaveBeenCalledTimes(1);
    expect(wrapper.get('[data-testid="model-support-target-org/model"]').attributes('data-status')).toBe('passed');
    wrapper.unmount();
  });

  it('applies investigation presets to scope and network policy before Start', async () => {
    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: 'hf.co/org/model' },
    });

    expect(wrapper.get('[data-testid="model-support-preset-full"]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('[data-testid="model-support-scope-model-load"]').attributes('data-state')).toBe('selected');

    await wrapper.get('[data-testid="model-support-preset-download-focused"]').trigger('click');
    expect(wrapper.get('[data-testid="model-support-preset-download-focused"]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('[data-testid="model-support-scope-repository-download"]').attributes('data-state')).toBe('selected');
    expect(wrapper.get('[data-testid="model-support-scope-model-load"]').attributes('data-state')).toBe('not-selected');
    expect(wrapper.get('[data-testid="model-support-scope-generation"]').attributes('data-state')).toBe('not-selected');

    await wrapper.get('[data-testid="model-support-investigation-start"]').trigger('click');
    await flushPromises();

    expect(workerMocks.runPartialInvestigation).toHaveBeenCalledWith(expect.objectContaining({
      configuration: {
        externalNetworkPolicy: 'allow',
        scope: {
          'repository-download': 'selected',
          'model-load': 'not-selected',
          generation: 'not-selected',
          continuity: 'not-selected',
          'capability-probes': 'not-selected',
        },
      },
    }));
    wrapper.unmount();
  });

  it('shows dependency-required scope without forcing Repository / Download', async () => {
    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: 'hf.co/org/model' },
    });

    await wrapper.get('[data-testid="model-support-preset-download-focused"]').trigger('click');
    await wrapper.get('[data-testid="model-support-scope-repository-download"]').trigger('click');
    await wrapper.get('[data-testid="model-support-scope-continuity"]').trigger('click');

    expect(wrapper.get('[data-testid="model-support-preset-custom"]').attributes('data-active')).toBe('true');
    expect(wrapper.get('[data-testid="model-support-scope-repository-download"]').attributes('data-state')).toBe('not-selected');
    expect(wrapper.get('[data-testid="model-support-scope-model-load"]').attributes('data-state')).toBe('required');
    expect(wrapper.get('[data-testid="model-support-scope-model-load"]').text()).toContain('Required by selected scope');
    expect(wrapper.get('[data-testid="model-support-scope-generation"]').attributes('data-state')).toBe('required');
    expect(wrapper.get('[data-testid="model-support-scope-continuity"]').attributes('data-state')).toBe('selected');
    expect(wrapper.get('[data-testid="model-support-scope-capability-probes"]').attributes('data-state')).toBe('not-selected');
    wrapper.unmount();
  });

  it('disables Start when no investigation scope is selected', async () => {
    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: 'hf.co/org/model' },
    });

    await wrapper.get('[data-testid="model-support-preset-download-focused"]').trigger('click');
    await wrapper.get('[data-testid="model-support-scope-repository-download"]').trigger('click');

    expect(wrapper.get('[data-testid="model-support-preset-custom"]').attributes('data-active')).toBe('true');
    expect(wrapper.get('[data-testid="model-support-investigation-start"]').attributes('disabled')).toBeDefined();

    await wrapper.get('[data-testid="model-support-investigation-start"]').trigger('click');
    await flushPromises();

    expect(workerMocks.runPartialInvestigation).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('applies the Offline preset as full scope with external network denied', async () => {
    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: 'hf.co/org/model' },
    });

    await wrapper.get('[data-testid="model-support-preset-offline"]').trigger('click');

    expect(wrapper.get('[data-testid="model-support-preset-offline"]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('[data-testid="model-support-network-deny"]').attributes('aria-pressed')).toBe('true');
    for (const scopeId of ['repository-download', 'model-load', 'generation', 'continuity', 'capability-probes']) {
      expect(wrapper.get(`[data-testid="model-support-scope-${scopeId}"]`).attributes('data-state')).toBe('selected');
    }
    wrapper.unmount();
  });

  it('applies the external-network policy selected before Start', async () => {
    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: 'hf.co/org/model' },
    });

    expect(wrapper.get('[data-testid="model-support-network-allow"]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('[data-testid="model-support-network-deny"]').attributes('aria-pressed')).toBe('false');

    await wrapper.get('[data-testid="model-support-network-deny"]').trigger('click');
    expect(wrapper.get('[data-testid="model-support-network-allow"]').attributes('aria-pressed')).toBe('false');
    expect(wrapper.get('[data-testid="model-support-network-deny"]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('[data-testid="model-support-investigation-start"]').attributes('disabled')).toBeUndefined();

    await wrapper.get('[data-testid="model-support-investigation-start"]').trigger('click');
    await flushPromises();

    expect(workerMocks.runPartialInvestigation).toHaveBeenCalledWith(expect.objectContaining({
      configuration: expect.objectContaining({ externalNetworkPolicy: 'deny' }),
    }));
    wrapper.unmount();
  });

  it('waits for explicit Start, normalizes the seeded target, and shows partial findings', async () => {
    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: 'hf.co/org/model' },
    });
    expect(workerMocks.runPartialInvestigation).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="model-support-target-row-org/model"]').text()).toContain('org/model');
    expect(wrapper.get('[data-testid="model-support-targets-input"]').element).toHaveProperty('value', '');
    await wrapper.get('[data-testid="model-support-investigation-start"]').trigger('click');

    await flushPromises();

    expect(wrapper.get('[data-testid="model-support-investigation-running-results"]').classes()).toContain('overflow-y-auto');
    expect(wrapper.find('[data-testid="model-support-investigation-setup"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="model-support-investigation-review"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="model-support-stage-running-results"]').attributes('data-state')).toBe('active');
    expect(workerMocks.runPartialInvestigation).toHaveBeenCalledWith({
      modelId: 'org/model',
      replayMetadataBudgetBytes: 48 * 1024 * 1024,
      configuration: {
        externalNetworkPolicy: 'allow',
        scope: {
          'repository-download': 'selected',
          'model-load': 'selected',
          generation: 'selected',
          continuity: 'selected',
          'capability-probes': 'selected',
        },
      },
      onEvent: expect.any(Function),
      onCheckpoint: expect.any(Function),
    });
    expect(wrapper.text()).toContain('org/model');
    expect(wrapper.text()).toContain('may be fingerprinting information');
    expect(wrapper.text()).toContain('Same-origin ONNX Runtime module, WASM, and control inference verified');
    expect(wrapper.get('[data-testid="model-support-lane-comparison"]').text()).toContain('AutoModelForCausalLM · tokenizer · standard · new_chat_model');
    expect(wrapper.get('[data-testid="model-support-production-load-attempts"]').text()).toContain('webgpu/q4f16: failed (Error: q4f16 load failed) → webgpu/q4: passed');
    expect(wrapper.get('[data-testid="model-support-lane-comparison"]').text()).toContain('match exactly (2 tokens)');
    expect(wrapper.get('[data-testid="model-support-production-tool-result-continuation"]').text()).toContain('exact template match');
    expect(wrapper.get('[data-testid="model-support-production-tool-result-continuation"]').text()).toContain('generated=1 token(s)');
    expect(wrapper.get('[data-testid="model-support-production-tool-result-continuation"]').text()).toContain('actual cross-turn tool KV reuse not observed');
    expect(wrapper.get('[data-testid="model-support-production-reasoning"]').text()).toContain('none=2 input token(s)');
    expect(wrapper.get('[data-testid="model-support-production-reasoning"]').text()).toContain('first mismatch at 1');
    expect(wrapper.get('[data-testid="model-support-production-reasoning"]').text()).toContain('output quality was not evaluated');
    expect(wrapper.get('[data-testid="model-support-production-multimodal"]').text()).toContain('single-transparent-pixel-png-v1');
    expect(wrapper.get('[data-testid="model-support-production-multimodal"]').text()).toContain('input tensors=3');
    expect(wrapper.get('[data-testid="model-support-production-multimodal"]').text()).toContain('generated=1 token(s)');
    expect(wrapper.get('[data-testid="model-support-production-multimodal"]').text()).toContain('output quality was not evaluated');
    expect(wrapper.get('[data-testid="model-support-step-runtime-assets"]').text()).toContain('Passed');
    expect(wrapper.get('[data-testid="model-support-wasm-control"]').text()).toContain('passed');
    expect(wrapper.get('[data-testid="model-support-webgpu-control"]').text()).toContain('passed');
    expect(wrapper.get('[data-testid="model-support-runtime-environment"]').text()).toContain('GPU Vendor');
    expect(wrapper.get('[data-testid="model-support-runtime-environment"]').text()).toContain('Wasm threads=4→1');
    expect(wrapper.get('[data-testid="model-support-runtime-environment"]').text()).toContain('pthread lifecycle=not-observed');
    expect(wrapper.get('[data-testid="model-support-step-repository-information"]').text()).toContain('Passed');
    expect(wrapper.text()).toContain('org/model@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(wrapper.text()).toContain('3 files · text-generation');
    expect(wrapper.text()).toContain('completion markers do not independently verify file bytes');
    expect(wrapper.text()).toContain('new_chat_model');
    expect(wrapper.text()).toContain('AutoModelForCausalLM');
    expect(wrapper.text()).toContain('ProbeTokenizer');
    expect(wrapper.get('[data-testid="model-support-tool-template-provenance"]').text()).toContain('2 assistant tool-call suffix tokens');
    expect(wrapper.get('[data-testid="model-support-candidate-webgpu-q4"]').text()).toContain('Eligible');
    expect(wrapper.get('[data-testid="model-support-step-model-file-plan"]').text()).toContain('Passed');
    expect(wrapper.get('[data-testid="model-support-step-loading-investigation"]').text()).toContain('Passed');
    expect(wrapper.get('[data-testid="model-support-load-attempt-webgpu-q4"]').text()).toContain('AutoModelForCausalLM');
    expect(wrapper.get('[data-testid="model-support-load-attempt-webgpu-q4"]').text()).toContain('minimum=42');
    expect(wrapper.get('[data-testid="model-support-load-attempt-webgpu-q4"]').text()).toContain('natural=2');
    expect(wrapper.get('[data-testid="model-support-tool-protocol-probe-webgpu-q4"]').text()).toContain('all 2 template-derived tokens');
    expect(wrapper.get('[data-testid="model-support-tool-protocol-probe-webgpu-q4"]').text()).toContain('Production standard parser recognized 1 tool call(s)');
    expect(wrapper.get('[data-testid="model-support-tool-protocol-probe-webgpu-q4"]').text()).toContain('re-rendered into 3 continuation token(s)');
    expect(wrapper.get('[data-testid="model-support-evidence-readiness"]').text()).toContain('implementation-ready');
    expect(wrapper.get('[data-testid="model-support-investigation-download"]').attributes('disabled')).toBeUndefined();
    expect(workerMocks.dispose).toHaveBeenCalledTimes(1);

    wrapper.unmount();
    expect(workerMocks.dispose).toHaveBeenCalledTimes(1);
  });

  it('lets the user stop a hung investigation without closing the modal first', async () => {
    let rejectInvestigation: ((error: Error) => void) | undefined;
    workerMocks.runPartialInvestigation.mockImplementation(() => new Promise((_resolve, reject) => {
      rejectInvestigation = reject;
    }));
    workerMocks.interrupt.mockImplementation(async () => {
      const error = new Error('Model Support Investigation was stopped by the user');
      error.name = 'ModelSupportInvestigationUserInterruptedError';
      rejectInvestigation?.(error);
    });
    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: 'hf.co/org/model' },
    });
    await wrapper.get('[data-testid="model-support-investigation-start"]').trigger('click');
    await flushPromises();

    const stop = wrapper.get('[data-testid="model-support-investigation-stop"]');
    await stop.trigger('click');
    await flushPromises();

    expect(workerMocks.interrupt).toHaveBeenCalledTimes(1);
    expect(workerMocks.dispose).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="model-support-investigation-stop"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="model-support-investigation-close"]').attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  it('treats Stop interrupt transport failure as best-effort cleanup', async () => {
    workerMocks.runPartialInvestigation.mockImplementation(() => new Promise(() => {}));
    workerMocks.interrupt
      .mockRejectedValueOnce(new Error('interrupt transport failed'))
      .mockResolvedValue(undefined);
    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: 'hf.co/org/model' },
    });
    await wrapper.get('[data-testid="model-support-investigation-start"]').trigger('click');
    await flushPromises();

    await wrapper.get('[data-testid="model-support-investigation-stop"]').trigger('click');
    await flushPromises();

    expect(workerMocks.interrupt).toHaveBeenCalledTimes(1);
    expect(workerMocks.dispose).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="model-support-investigation-stop"]').exists()).toBe(true);

    wrapper.unmount();
    await flushPromises();
    expect(workerMocks.interrupt).toHaveBeenCalledTimes(2);
    expect(workerMocks.dispose).toHaveBeenCalledTimes(1);
  });

  it('treats unmount interrupt transport failure as best-effort cleanup', async () => {
    workerMocks.runPartialInvestigation.mockImplementation(() => new Promise(() => {}));
    workerMocks.interrupt.mockRejectedValue(new Error('interrupt transport failed'));
    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: 'hf.co/org/model' },
    });
    await wrapper.get('[data-testid="model-support-investigation-start"]').trigger('click');
    await flushPromises();

    wrapper.unmount();
    await flushPromises();

    expect(workerMocks.interrupt).toHaveBeenCalledTimes(1);
    expect(workerMocks.dispose).toHaveBeenCalledTimes(1);
  });

  it('exports the last interrupted checkpoint after force-stopping a hung investigation', async () => {
    let rejectInvestigation: ((error: Error) => void) | undefined;
    let publishCheckpoint: ((value: unknown) => void) | undefined;
    const runningRun = structuredClone(completedRun);
    runningRun.currentOperation = 'production-webgpu-q4f16: model-load';
    const completedProductionObservation = runningRun.productionLane.observation;
    if (completedProductionObservation === undefined) throw new Error('Production fixture is unavailable');
    const completedLoadAttempt = completedProductionObservation.loadAttempts?.[0];
    if (completedLoadAttempt === undefined) throw new Error('Production load-attempt fixture is unavailable');
    runningRun.productionLane = {
      status: 'running',
      observation: undefined,
      partialObservation: {
        modelId: completedProductionObservation.modelId,
        resolvedRevision: completedProductionObservation.resolvedRevision,
        loaderRevisionOption: null,
        runtimeLoadDurationMs: undefined,
        candidate: undefined,
        loadAttempts: [completedLoadAttempt],
        activeLoadAttempt: {
          candidate: { device: 'webgpu', dtype: 'q4' },
          status: 'running',
          modelLoadDurationMs: 6_000,
          modelLoadProgress: {
            kind: 'model-load',
            artifactSource: 'downloaded-model-cache',
            candidateId: 'production-webgpu-q4',
            sourceStatus: 'progress',
            currentFile: 'onnx/model_q4.onnx_data',
            fileLoaded: 64 * 1024 * 1024,
            fileTotal: 256 * 1024 * 1024,
            fileProgress: 25,
            aggregateLoaded: 64 * 1024 * 1024,
            aggregateTotal: 256 * 1024 * 1024,
            aggregateProgress: 25,
            eventCount: 100_000,
            progressEventCount: 100_000,
            progressTotalEventCount: 100_000,
            forwardProgressCount: 100_000,
            repeatedWithoutForwardProgressCount: 0,
            publishedSampleCount: 2,
            cacheMatchRequestCount: 12,
            cacheHitCount: 11,
            cacheMissCount: 1,
            cacheAliasHitCount: 2,
            cacheMatchedBytes: 1_582_178_925,
            remoteFetchAttemptCount: 0,
            firstActivityAt: '2026-08-06T00:00:02.000Z',
            lastActivityAt: '2026-08-06T00:00:08.000Z',
            lastForwardProgressAt: '2026-08-06T00:00:08.000Z',
          },
        },
        route: undefined,
        isEncoderDecoder: undefined,
        firstTurn: undefined,
        continuity: undefined,
        toolResultContinuation: undefined,
        reasoning: undefined,
        multimodal: undefined,
      },
      error: undefined,
    };
    workerMocks.runPartialInvestigation.mockImplementation(({ onCheckpoint }) => {
      publishCheckpoint = onCheckpoint;
      onCheckpoint({
        checkpoint: {
          run: runningRun,
          recovery: {
            schemaVersion: 1,
            status: 'running',
            checkpointSequence: 20,
            checkpointedAt: '2026-08-06T00:00:20.000Z',
            totalEventCount: 20,
            droppedEventCount: 0,
            lastEvent: undefined,
            events: [],
            interruption: undefined,
          },
        },
      });
      return new Promise((_resolve, reject) => {
        rejectInvestigation = reject;
      });
    });
    workerMocks.interrupt.mockImplementation(async () => {
      const error = new Error('Model Support Investigation was stopped by the user');
      error.name = 'ModelSupportInvestigationUserInterruptedError';
      publishCheckpoint?.({
        checkpoint: {
          run: {
            ...runningRun,
            status: 'failed',
            currentOperation: 'Investigation interrupted after lane-comparison',
          },
          recovery: {
            schemaVersion: 1,
            status: 'interrupted',
            checkpointSequence: 21,
            checkpointedAt: '2026-08-06T00:00:21.000Z',
            totalEventCount: 20,
            droppedEventCount: 0,
            lastEvent: undefined,
            events: [],
            interruption: {
              at: '2026-08-06T00:00:21.000Z',
              lastEventSequence: undefined,
              error: { name: error.name, message: error.message, stack: undefined },
            },
          },
        },
      });
      rejectInvestigation?.(error);
    });

    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: 'hf.co/org/model' },
    });
    await wrapper.get('[data-testid="model-support-investigation-start"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="model-support-production-load-attempts"]').text()).toContain(
      'webgpu/q4f16: failed (Error: q4f16 load failed) → webgpu/q4: running (raw-events=100000, published-samples=2, cache=11 hit/1 miss/2 alias · opfs-matched-bytes=1582178925 · remote-fetch-attempts=0)',
    );
    await wrapper.get('[data-testid="model-support-investigation-stop"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="model-support-investigation-download"]').trigger('click');
    await flushPromises();

    expect(evidenceMocks.createPartialEvidence).toHaveBeenCalledTimes(1);
    expect(evidenceMocks.createPartialEvidence.mock.calls[0]?.[0].recovery).toMatchObject({
      status: 'interrupted',
      interruption: {
        error: { name: 'ModelSupportInvestigationUserInterruptedError' },
      },
    });
    expect(evidenceMocks.dispose).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('shows persistence serialization evidence without implying physical storage I/O', async () => {
    const persistenceRun = structuredClone(completedRun);
    persistenceRun.persistenceRoundTrip = {
      status: 'observed',
      fixtureId: 'tool-call-history-v1',
      method: 'chat-content-dto-json-roundtrip-v1',
      serializedByteLength: 321,
      serializedSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      originalMessages: [],
      restoredMessages: [],
      exactModelVisibleMatch: false,
      firstMismatchIndex: 2,
    };
    workerMocks.runPartialInvestigation.mockResolvedValue(persistenceRun);

    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: 'hf.co/org/model' },
    });
    await wrapper.get('[data-testid="model-support-investigation-start"]').trigger('click');
    await flushPromises();

    const summary = wrapper.get('[data-testid="model-support-persistence-roundtrip"]').text();
    expect(summary).toContain('Persistence serialization contract');
    expect(summary).toContain('mismatch at 2');
    expect(summary).toContain('JSON=321 bytes');
    expect(summary).toContain('physical storage I/O=not observed');
    wrapper.unmount();
  });

  it('shows the Production cache decision and decoded reconstructed-prefix mismatch context', async () => {
    const continuityRun = structuredClone(completedRun);
    const observation = continuityRun.productionLane.observation;
    if (observation === undefined || observation.firstTurn.status !== 'passed') {
      throw new Error('Production first-turn fixture is unavailable');
    }
    const secondTurn = {
      ...structuredClone(observation.firstTurn.turn),
      messages: [
        { role: 'user' as const, content: 'Template probe user message.' },
        { role: 'assistant' as const, content: 'production' },
        { role: 'user' as const, content: 'Continue with one short sentence.' },
      ],
      inputTokenIds: [1, 9, 10],
      fullConversationInput: { status: 'observed' as const, inputTokenIds: [1, 9, 10] },
      cacheDecision: { status: 'reused' as const, reason: 'qwen3_5-no-tool-continuation' },
      pastKeyValuesProvided: true,
    };
    observation.continuity = {
      status: 'passed',
      assistantMessage: { role: 'assistant', content: 'production' },
      followUpMessage: { role: 'user', content: 'Continue with one short sentence.' },
      secondTurn,
      prefixComparison: {
        mode: 'full-input-prefix',
        expectedPrefixTokenIds: [1, 2, 45],
        secondInputTokenIds: [1, 9, 10],
        reconstructedFullInputTokenIds: [1, 9, 10],
        comparisonInputSource: 'reconstructed-full-conversation',
        exactPrefixMatch: false,
        firstMismatchIndex: 1,
        firstMismatchContext: {
          startIndex: 0,
          expectedTokenIds: [1, 2, 45],
          actualTokenIds: [1, 9, 10],
          expectedText: '<expected-prefix>',
          actualText: '<actual-prefix>',
        },
      },
    };
    workerMocks.runPartialInvestigation.mockResolvedValue(continuityRun);

    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: 'hf.co/org/model' },
    });
    await wrapper.get('[data-testid="model-support-investigation-start"]').trigger('click');
    await flushPromises();

    const summary = wrapper.get('[data-testid="model-support-production-continuity"]').text();
    expect(summary).toContain('qwen3_5-no-tool-continuation');
    expect(summary).toContain('reconstructed-full-conversation');
    expect(summary).toContain('<expected-prefix>');
    expect(summary).toContain('<actual-prefix>');
    wrapper.unmount();
  });

  it('shows runtime observations that were checkpointed before preflight failed', async () => {
    const partialRuntimeRun: ModelSupportInvestigationRun = structuredClone(completedRun);
    partialRuntimeRun.status = 'failed';
    partialRuntimeRun.runtimeAssets = undefined;
    partialRuntimeRun.runtimeAssetsPartial = {
      variant: 'asyncify',
      baseUrl: 'https://naidan.example/app/transformers/',
      mjsUrl: 'https://naidan.example/app/transformers/ort-wasm-simd-threaded.asyncify.mjs',
      wasmUrl: 'https://naidan.example/app/transformers/ort-wasm-simd-threaded.asyncify.wasm',
      physicalWasmUrl: 'https://naidan.example/app/transformers/ort-wasm-simd-threaded.asyncify.wasm',
      applicationOrigin: 'https://naidan.example',
      mjsOrigin: 'https://naidan.example',
      wasmOrigin: 'https://naidan.example',
      physicalWasmOrigin: 'https://naidan.example',
      environment: completedRun.runtimeAssets?.environment,
      wasmByteLength: undefined,
      control: {
        fixtureId: 'identity-float32-v1',
        fixtureSha256: '19be871867d45a5bb90b850518b38262a67d14cfccc147f6566f15308c273443',
        executionProvider: 'wasm',
        status: 'failed',
        inputName: 'x',
        outputName: 'y',
        inputValue: 7,
        outputValue: undefined,
        error: 'Wasm control failed',
      },
      webGpuControl: {
        fixtureId: 'identity-float32-v1',
        fixtureSha256: '19be871867d45a5bb90b850518b38262a67d14cfccc147f6566f15308c273443',
        executionProvider: 'webgpu',
        status: 'passed',
        inputName: 'x',
        outputName: 'y',
        inputValue: 7,
        outputValue: 7,
        error: undefined,
      },
      currentStage: undefined,
      stageObservations: [
        { stage: 'origin-validation', status: 'passed', detail: 'Same-origin URLs verified' },
        { stage: 'environment', status: 'passed', detail: 'Environment observed' },
        { stage: 'module-import', status: 'failed', detail: 'Runtime module import failed', error: 'Import failed' },
        { stage: 'wasm-control', status: 'failed', detail: 'Wasm control failed', error: 'Wasm control failed' },
        { stage: 'webgpu-control', status: 'passed', detail: 'WebGPU control passed' },
      ],
    };
    partialRuntimeRun.steps = partialRuntimeRun.steps.map(step => step.id === 'runtime-assets'
      ? { ...step, status: 'failed', detail: 'Runtime module import failed' }
      : step);
    workerMocks.runPartialInvestigation.mockResolvedValue(partialRuntimeRun);

    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: 'hf.co/org/model' },
    });
    await wrapper.get('[data-testid="model-support-investigation-start"]').trigger('click');

    await flushPromises();

    expect(wrapper.get('[data-testid="model-support-step-runtime-assets"]').text()).toContain('Failed');
    expect(wrapper.get('[data-testid="model-support-runtime-environment"]').text()).toContain('GPU Vendor');
    expect(wrapper.get('[data-testid="model-support-wasm-control"]').text()).toContain('failed');
    expect(wrapper.get('[data-testid="model-support-wasm-control"]').text()).toContain('Wasm control failed');
    expect(wrapper.get('[data-testid="model-support-webgpu-control"]').text()).toContain('passed');

    wrapper.unmount();
  });

  it('keeps raw progress event churn out of the current operation while showing forward-progress diagnostics', async () => {
    workerMocks.runPartialInvestigation.mockImplementation(async ({ onEvent }) => {
      onEvent({
        event: {
          stepId: 'loading-investigation',
          status: 'running',
          detail: 'webgpu-q4f16: model-load',
          progress: {
            kind: 'model-load',
            artifactSource: 'downloaded-model-cache',
            artifactSourceBasis: 'load-policy',
            candidateId: 'webgpu-q4f16',
            sourceStatus: 'progress_total',
            progressByteSemantics: 'response-body-read-not-network-proof',
            currentFile: 'onnx/model_q4f16.onnx_data',
            fileLoaded: 1048576,
            fileTotal: 4194304,
            fileProgress: 25,
            aggregateLoaded: 2097152,
            aggregateTotal: 8388608,
            aggregateProgress: 25,
            eventCount: 42,
            progressEventCount: 20,
            progressTotalEventCount: 21,
            forwardProgressCount: 17,
            repeatedWithoutForwardProgressCount: 3,
            publishedSampleCount: 4,
            cacheMatchRequestCount: 7,
            cacheHitCount: 7,
            cacheMissCount: 0,
            cacheAliasHitCount: 1,
            cacheMatchedBytes: 8_388_608,
            remoteFetchAttemptCount: 0,
            lastActivityAt: new Date().toISOString(),
            lastForwardProgressAt: new Date().toISOString(),
          },
        },
      });
      return completedRun;
    });

    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: 'hf.co/org/model' },
    });
    await wrapper.get('[data-testid="model-support-investigation-start"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-testid="model-support-current-operation"]').text()).not.toContain('progress_total');
    expect(wrapper.get('[data-testid="model-support-live-progress"]').text()).toContain('progress_total=21');
    expect(wrapper.get('[data-testid="model-support-live-progress"]').text()).toContain('progress=20');
    expect(wrapper.get('[data-testid="model-support-live-progress"]').text()).toContain('forward=17');
    expect(wrapper.get('[data-testid="model-support-live-progress"]').text()).toContain('repeated-no-forward=3');
    expect(wrapper.get('[data-testid="model-support-live-progress"]').text()).toContain('cache=7 hit/0 miss/1 alias');
    expect(wrapper.get('[data-testid="model-support-live-progress"]').text()).toContain('opfs-matched-bytes=8388608');
    expect(wrapper.get('[data-testid="model-support-live-progress"]').text()).toContain('remote-fetch-attempts=0');
    wrapper.unmount();
  });

  it('exports a checkpoint snapshot while investigation is still running', async () => {
    let resolveInvestigation!: (run: ModelSupportInvestigationRun) => void;
    const pendingInvestigation = new Promise<ModelSupportInvestigationRun>(resolve => {
      resolveInvestigation = resolve;
    });
    const checkpointRun = structuredClone(completedRun);
    checkpointRun.currentOperation = 'webgpu-q4f16: model-load';
    workerMocks.runPartialInvestigation.mockImplementation(({ onCheckpoint }) => {
      onCheckpoint({
        checkpoint: {
          run: checkpointRun,
          recovery: {
            schemaVersion: 1,
            status: 'running',
            checkpointSequence: 4,
            checkpointedAt: '2026-08-06T00:00:00.500Z',
            totalEventCount: 0,
            droppedEventCount: 0,
            lastEvent: undefined,
            events: [],
            interruption: undefined,
          },
        },
      });
      return pendingInvestigation;
    });

    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: 'hf.co/org/model' },
    });
    await wrapper.get('[data-testid="model-support-investigation-start"]').trigger('click');
    await flushPromises();

    const download = wrapper.get('[data-testid="model-support-investigation-download"]');
    expect(download.attributes('disabled')).toBeUndefined();
    expect(wrapper.get('[data-testid="model-support-investigation-close"]').attributes('disabled')).toBeDefined();

    await download.trigger('click');
    await flushPromises();

    expect(evidenceMocks.createPartialEvidence).toHaveBeenCalledTimes(1);
    const exported = evidenceMocks.createPartialEvidence.mock.calls[0]?.[0];
    expect(exported.run.currentOperation).toBe('webgpu-q4f16: model-load');
    expect(exported.run.steps.find((step: { id: string }) => step.id === 'evidence-export')).toMatchObject({ status: 'passed' });
    expect(exported.recovery).toMatchObject({ status: 'running', checkpointSequence: 4 });
    expect(wrapper.get('[data-testid="model-support-execution-summary"]').text()).toContain('investigation is running');

    resolveInvestigation(completedRun);
    await flushPromises();
    wrapper.unmount();
  });

  it('clicks a connected Evidence download anchor before revoking its Object URL', async () => {
    const click = vi.mocked(HTMLAnchorElement.prototype.click);
    click.mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.isConnected).toBe(true);
      expect(this.download).toBe('evidence.zip');
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    });

    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: 'hf.co/org/model' },
    });
    await wrapper.get('[data-testid="model-support-investigation-start"]').trigger('click');
    await flushPromises();

    await wrapper.get('[data-testid="model-support-investigation-download"]').trigger('click');
    await vi.waitFor(() => expect(click).toHaveBeenCalledTimes(1));

    expect(document.querySelector('a[download="evidence.zip"]')).toBeNull();
    await vi.waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:evidence'));
    wrapper.unmount();
  });

  it('records verified evidence export success in the packaged run and UI', async () => {
    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: 'hf.co/org/model' },
    });
    await wrapper.get('[data-testid="model-support-investigation-start"]').trigger('click');
    await flushPromises();

    await wrapper.get('[data-testid="model-support-investigation-download"]').trigger('click');
    await flushPromises();

    expect(evidenceMocks.createPartialEvidence).toHaveBeenCalledTimes(1);
    const packagedRun = evidenceMocks.createPartialEvidence.mock.calls[0]?.[0].run as ModelSupportInvestigationRun;
    expect(packagedRun.steps.find(step => step.id === 'evidence-export')).toMatchObject({
      status: 'passed',
      detail: 'Evidence Export: Passed',
    });
    expect(wrapper.get('[data-testid="model-support-step-evidence-export"]').text()).toContain('Passed');
    wrapper.unmount();
  });

  it('keeps a successful evidence export successful when Evidence Worker cleanup fails', async () => {
    evidenceMocks.dispose.mockRejectedValueOnce(new Error('cleanup failed'));
    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: 'hf.co/org/model' },
    });
    await wrapper.get('[data-testid="model-support-investigation-start"]').trigger('click');
    await flushPromises();

    await wrapper.get('[data-testid="model-support-investigation-download"]').trigger('click');
    await flushPromises();

    expect(evidenceMocks.dispose).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(wrapper.get('[data-testid="model-support-step-evidence-export"]').text()).toContain('Passed');
    wrapper.unmount();
  });

  it('records evidence export verification failure without downloading an archive', async () => {
    evidenceMocks.createPartialEvidence.mockRejectedValue(new Error('archive verification failed'));
    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: 'hf.co/org/model' },
    });
    await wrapper.get('[data-testid="model-support-investigation-start"]').trigger('click');
    await flushPromises();

    await wrapper.get('[data-testid="model-support-investigation-download"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-testid="model-support-step-evidence-export"]').text()).toContain('Failed');
    expect(wrapper.text()).toContain('archive verification failed');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(evidenceMocks.dispose).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('shows conservative support boundary assessments when exact capability evidence exists', async () => {
    const boundaryRun = structuredClone(completedRun);
    boundaryRun.declarations!.classCapabilities = boundaryRun.declarations!.classCapabilities.map(item => ({
      ...item,
      supports: false,
    }));
    boundaryRun.loadAttempts = [];
    workerMocks.runPartialInvestigation.mockResolvedValue(boundaryRun);

    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: 'hf.co/org/model' },
    });
    await wrapper.get('[data-testid="model-support-investigation-start"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-testid="model-support-boundary-assessment"]').text()).toContain('transformers-js-capability');
    wrapper.unmount();
  });
});
