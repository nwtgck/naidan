import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { toToolCallId } from '@/01-models/ids';
import ModelSupportInvestigationModal from './ModelSupportInvestigationModal.vue';
import type { ModelSupportInvestigationRun } from '@/features/transformers-js/model-support-investigation/types';

const fixtureToolCallId = toToolCallId({ raw: 'call_fixture' });

const workerMocks = vi.hoisted(() => ({
  runPartialInvestigation: vi.fn(),
  interrupt: vi.fn(),
  dispose: vi.fn(),
}));

const evidenceMocks = vi.hoisted(() => ({
  createPartialEvidence: vi.fn(),
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
    vi.clearAllMocks();
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

  it('runs the real-worker boundary automatically and shows partial findings', async () => {
    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: 'hf.co/org/model' },
    });

    await flushPromises();

    expect(workerMocks.runPartialInvestigation).toHaveBeenCalledWith({
      modelId: 'hf.co/org/model',
      onEvent: expect.any(Function),
      onCheckpoint: expect.any(Function),
    });
    expect(wrapper.text()).toContain('hf.co/org/model');
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
    await flushPromises();

    const download = wrapper.get('[data-testid="model-support-investigation-download"]');
    expect(download.attributes('disabled')).toBeUndefined();
    expect(wrapper.get('[data-testid="model-support-investigation-close"]').attributes('disabled')).toBeDefined();

    await download.trigger('click');
    await flushPromises();

    expect(evidenceMocks.createPartialEvidence).toHaveBeenCalledTimes(1);
    const exported = evidenceMocks.createPartialEvidence.mock.calls[0]?.[0];
    expect(exported.run.currentOperation).not.toBe('webgpu-q4f16: model-load');
    expect(exported.run.steps.find((step: { id: string }) => step.id === 'evidence-export')).toMatchObject({ status: 'passed' });
    expect(exported.recovery).toMatchObject({ status: 'running', checkpointSequence: 4 });

    resolveInvestigation(completedRun);
    await flushPromises();
    wrapper.unmount();
  });

  it('records verified evidence export success in the packaged run and UI', async () => {
    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: 'hf.co/org/model' },
    });
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

  it('records evidence export verification failure without downloading an archive', async () => {
    evidenceMocks.createPartialEvidence.mockRejectedValue(new Error('archive verification failed'));
    const wrapper = mount(ModelSupportInvestigationModal, {
      props: { modelId: 'hf.co/org/model' },
    });
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
    await flushPromises();

    expect(wrapper.get('[data-testid="model-support-boundary-assessment"]').text()).toContain('transformers-js-capability');
    wrapper.unmount();
  });
});
