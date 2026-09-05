import { describe, expect, it } from 'vitest';
import { selectDownloadRuntimeCandidates } from '@/features/transformers-js/model-support-investigation/logic/select-download-runtime-candidates';
import type { ModelSupportInvestigationCandidateFilePlan, ModelSupportInvestigationModelFilePlan } from '@/features/transformers-js/model-support-investigation/types';

const REVISION = 'c6f46e4e3f885ebcad164d14059a49f90e27eb4d';

function candidate({
  candidateId,
  device,
  dtype,
  eligibility,
  paths,
  cachedRevision,
}: {
  candidateId: ModelSupportInvestigationCandidateFilePlan['candidateId'];
  device: ModelSupportInvestigationCandidateFilePlan['device'];
  dtype: ModelSupportInvestigationCandidateFilePlan['dtype'];
  eligibility: ModelSupportInvestigationCandidateFilePlan['eligibility'];
  paths: string[];
  cachedRevision?: string;
}): ModelSupportInvestigationCandidateFilePlan {
  return {
    candidateId,
    device,
    dtype,
    registryStatus: 'planned',
    registryError: undefined,
    registryReturnedFileCount: paths.length,
    duplicatePaths: [],
    files: paths.map(path => ({
      path,
      kind: path === 'config.json' ? 'config' : path.endsWith('.onnx') ? 'core-onnx' : 'external-data',
      requirement: 'required',
      repositoryObservation: eligibility === 'eligible' ? 'present' : 'missing',
      repositorySize: 10,
      repositoryBlobId: undefined,
      repositoryLfsOid: undefined,
      cacheMatches: cachedRevision === undefined ? [] : [{
        path: `resolve/${cachedRevision}/${path}`,
        size: 10,
        hasCompletionMarker: true,
        observation: 'complete-marker-observed-revision-unknown',
      }],
    })),
    requiredFileCount: paths.length,
    optionalFileCount: 0,
    missingRequiredFileCount: eligibility === 'eligible' ? 0 : paths.length,
    zeroByteRequiredFileCount: 0,
    missingOptionalFileCount: 0,
    cacheObservedRequiredFileCount: cachedRevision === undefined ? 0 : paths.length,
    cacheCompleteMarkerRequiredFileCount: cachedRevision === undefined ? 0 : paths.length,
    eligibility,
    ineligibleReasons: eligibility === 'eligible' ? [] : ['missing required repository file'],
  };
}

function plan(): ModelSupportInvestigationModelFilePlan {
  return {
    normalizedModelId: 'LiquidAI/LFM2.5-230M-ONNX',
    resolvedRevision: REVISION,
    modelType: 'lfm2',
    registrySource: 'ModelRegistry.get_model_files',
    cacheRevisionProvenance: 'unknown',
    cacheRevisionProvenanceReason: 'fixture',
    candidates: [
      candidate({
        candidateId: 'webgpu-q4f16',
        device: 'webgpu',
        dtype: 'q4f16',
        eligibility: 'ineligible',
        paths: ['config.json', 'onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data'],
      }),
      candidate({
        candidateId: 'webgpu-q4',
        device: 'webgpu',
        dtype: 'q4',
        eligibility: 'eligible',
        paths: ['config.json', 'onnx/model_q4.onnx', 'onnx/model_q4.onnx_data'],
        cachedRevision: REVISION,
      }),
      candidate({
        candidateId: 'wasm-q4',
        device: 'wasm',
        dtype: 'q4',
        eligibility: 'eligible',
        paths: ['config.json', 'onnx/model_q4.onnx', 'onnx/model_q4.onnx_data'],
        cachedRevision: REVISION,
      }),
    ],
  };
}

describe('selectDownloadRuntimeCandidates', () => {
  it('excludes repository-ineligible q4f16 and reuses only candidates complete in the exact revision cache', () => {
    const result = selectDownloadRuntimeCandidates({ modelFilePlan: plan() });

    expect(result.candidateOrder).toEqual([
      { device: 'webgpu', dtype: 'q4' },
      { device: 'wasm', dtype: 'q4' },
    ]);
    expect(result.reusableCandidateOrderByRevision[REVISION]).toEqual([
      { device: 'webgpu', dtype: 'q4' },
      { device: 'wasm', dtype: 'q4' },
    ]);
    expect(result.reusableCandidateOrderByRevision.main).toEqual([]);
    expect(result.requiredModelPathsByCandidate['webgpu/q4']).toEqual([
      'onnx/model_q4.onnx',
      'onnx/model_q4.onnx_data',
    ]);
  });

  it('does not reuse a repository-eligible candidate when one required cache file is absent', () => {
    const modelFilePlan = plan();
    const webgpuQ4 = modelFilePlan.candidates.find(item => item.candidateId === 'webgpu-q4')!;
    webgpuQ4.files.find(file => file.path === 'onnx/model_q4.onnx_data')!.cacheMatches = [];

    const result = selectDownloadRuntimeCandidates({ modelFilePlan });

    expect(result.candidateOrder).toContainEqual({ device: 'webgpu', dtype: 'q4' });
    expect(result.reusableCandidateOrderByRevision[REVISION]).not.toContainEqual({ device: 'webgpu', dtype: 'q4' });
  });

  it('keeps repository-confirmed staged model artifacts even when they are not yet cached', () => {
    const modelFilePlan = plan();
    const webgpuQ4 = modelFilePlan.candidates.find(item => item.candidateId === 'webgpu-q4')!;
    webgpuQ4.files.push({
      path: 'onnx/vision_encoder_q4.onnx_data',
      kind: 'external-data',
      requirement: 'required',
      repositoryObservation: 'present',
      repositorySize: 10,
      repositoryBlobId: undefined,
      repositoryLfsOid: undefined,
      cacheMatches: [],
    });

    const result = selectDownloadRuntimeCandidates({ modelFilePlan });

    expect(result.requiredModelPathsByCandidate['webgpu/q4']).toEqual([
      'onnx/model_q4.onnx',
      'onnx/model_q4.onnx_data',
      'onnx/vision_encoder_q4.onnx_data',
    ]);
  });

  it('preserves all repository-confirmed Qwen3.5 composite q4f16 weights even when held-fetch observed only decoder and embedding requests', () => {
    const modelFilePlan = plan();
    const q4f16 = modelFilePlan.candidates.find(item => item.candidateId === 'webgpu-q4f16')!;
    q4f16.eligibility = 'eligible';
    q4f16.ineligibleReasons = [];
    q4f16.registryReturnedFileCount = 6;
    q4f16.requiredFileCount = 6;
    q4f16.missingRequiredFileCount = 0;
    q4f16.files = [
      'onnx/decoder_model_merged_q4f16.onnx',
      'onnx/decoder_model_merged_q4f16.onnx_data',
      'onnx/embed_tokens_q4f16.onnx',
      'onnx/embed_tokens_q4f16.onnx_data',
      'onnx/vision_encoder_q4f16.onnx',
      'onnx/vision_encoder_q4f16.onnx_data',
    ].map(path => ({
      path,
      kind: path.endsWith('.onnx') ? 'core-onnx' as const : 'external-data' as const,
      requirement: 'required' as const,
      repositoryObservation: 'present' as const,
      repositorySize: 10,
      repositoryBlobId: undefined,
      repositoryLfsOid: undefined,
      cacheMatches: [],
    }));

    const result = selectDownloadRuntimeCandidates({ modelFilePlan });

    expect(result.requiredModelPathsByCandidate['webgpu/q4f16']).toEqual([
      'onnx/decoder_model_merged_q4f16.onnx',
      'onnx/decoder_model_merged_q4f16.onnx_data',
      'onnx/embed_tokens_q4f16.onnx',
      'onnx/embed_tokens_q4f16.onnx_data',
      'onnx/vision_encoder_q4f16.onnx',
      'onnx/vision_encoder_q4f16.onnx_data',
    ]);
  });
});
