import type { RecoverableImageExecutionOutput } from '@/features/image-generation/execution/types';
import { copyImageGenerationRuntime } from '@/01-models/image-generation-remote';
import { generateId } from '@/01-models/id';
import type { BinaryObjectId, ImageGenerationId } from '@/01-models/ids';
import type { ImageGenerationModelFile, ImageGenerationRecord } from '@/01-models/image-generation-history';
import { exactObject } from '@/utils/exact-object';
import type { Request, PreviewFrame, Response } from '@/features/stable-diffusion-cpp-browser/types';

export type HistoryBinaryFile = { binaryObjectId: BinaryObjectId, blob: Blob, name: string };
export type ImageGenerationSnapshot = {
  id: ImageGenerationId,
  createdAt: number,
  request: ImageGenerationRecord['request'],
  inputFiles: HistoryBinaryFile[],
};

/** Copy metadata explicitly; File/Blob payloads are immutable and stay local.
 * In particular, do not structuredClone a potentially reactive editor value. */
export function copyImageGenerationSnapshot({ snapshot }: { snapshot: ImageGenerationSnapshot }): ImageGenerationSnapshot {
  const { id, createdAt, request, inputFiles, ...rest } = snapshot;
  rest satisfies Record<PropertyKey, never>;
  const { parameters, models, loras, imageInputs, preview, runtime, ...requestRest } = request;
  requestRest satisfies Record<PropertyKey, never>;
  return { id, createdAt, inputFiles: inputFiles.map(file => ({ ...file })), request: {
    parameters: { ...parameters }, preview: { ...preview }, runtime: copyImageGenerationRuntime({ runtime }),
    models: models.map(({ file, companions, ...model }) => ({ ...model, file: { ...file }, companions: companions.map(companion => ({ ...companion, file: { ...companion.file } })) })),
    loras: loras.map(lora => ({ ...lora, file: { ...lora.file } })),
    imageInputs: { initImage: imageInputs.initImage && { ...imageInputs.initImage }, strength: imageInputs.strength,
      referenceImages: imageInputs.referenceImages.map(image => ({ ...image })) },
  } };
}

/** Freeze the complete request before generation; mutable form state is never read on completion. */
export function snapshotImageGeneration({ request, sourceCommit, locateFile, createdAt, identifyInput }: {
  request: Request,
  sourceCommit: string,
  locateFile: ({ file }: { file: File }) => ImageGenerationModelFile,
  createdAt: number,
  identifyInput?: ({ file }: { file: File }) => BinaryObjectId,
}): ImageGenerationSnapshot {
  const inputFiles: HistoryBinaryFile[] = [];
  function inputImage({ file }: { file: File }) {
    const binaryObjectId = identifyInput ? identifyInput({ file }) : generateId<BinaryObjectId>();
    if (!inputFiles.some(input => input.binaryObjectId === binaryObjectId)) inputFiles.push({ binaryObjectId, blob: file, name: file.name });
    return { binaryObjectId, name: file.name };
  }
  const { artifact, models, loras, imageInputs, parameters, preview, weightResidency, gpuBudgetMiB,
    debug: _debug, runId: _runId, sessionId: _sessionId, baseUrl: _baseUrl, ...unhandled } = request;
  unhandled satisfies Record<PropertyKey, never>;
  return {
    id: generateId<ImageGenerationId>(), createdAt,
    request: exactObject<ImageGenerationRecord['request']>()({
      parameters: exactObject<ImageGenerationRecord['request']['parameters']>()({ ...parameters }),
      models: models.map(({ slot, file, path, companions, sourceId: _sourceId, ...rest }) => {
        rest satisfies Record<PropertyKey, never>;
        return { slot, path: path ?? file.name, file: locateFile({ file }), companions: (companions ?? []).map(({ path, file, ...rest }) => {
          rest satisfies Record<PropertyKey, never>;
          return { path, file: locateFile({ file }) };
        }) };
      }),
      loras: loras.map(({ file, path, strength, ...rest }) => {
        rest satisfies Record<PropertyKey, never>;
        return { path: path ?? file.name, file: locateFile({ file }), strength };
      }),
      imageInputs: {
        initImage: imageInputs.initImage && inputImage({ file: imageInputs.initImage }),
        strength: imageInputs.strength,
        referenceImages: imageInputs.referenceImages.map(file => inputImage({ file })),
      },
      preview: exactObject<ImageGenerationRecord['request']['preview']>()({ ...preview }),
      runtime: { sourceCommit, profile: artifact.profile, weightResidency, gpuBudgetMiB },
    }),
    inputFiles,
  };
}

export function finishImageGenerationSnapshot({ snapshot, result, previews, elapsedMs }: {
  snapshot: ImageGenerationSnapshot,
  result: Response,
  previews: PreviewFrame[],
  elapsedMs: number,
}): { record: ImageGenerationRecord, files: HistoryBinaryFile[] } {
  const { id, createdAt, request, inputFiles, ...rest } = snapshot;
  rest satisfies Record<PropertyKey, never>;
  const finalId = generateId<BinaryObjectId>();
  const files = [...inputFiles, { binaryObjectId: finalId, blob: result.png, name: 'generated-image.png' }];
  return {
    record: {
      id, createdAt, request,
      result: { binaryObjectId: finalId, width: result.width, height: result.height, modelVersion: result.modelVersion, uniformOutput: result.uniformOutput ?? false, elapsedMs },
      previews: previews.map(frame => {
        const binaryObjectId = generateId<BinaryObjectId>();
        files.push({ binaryObjectId, blob: frame.png, name: `preview-step-${frame.step}.png` });
        return { binaryObjectId, step: frame.step, steps: frame.steps, mode: frame.mode, width: frame.width, height: frame.height };
      }),
    },
    files,
  };
}

/** Complete pixels without confirmed execution metadata are recoverable,
 * never a successful generated output. Keep their identity stable on save retry. */
export function recoverImageGenerationSnapshot({ snapshot, output, elapsedMs }: {
  snapshot: ImageGenerationSnapshot, output: RecoverableImageExecutionOutput, elapsedMs: number,
}): { record: ImageGenerationRecord, files: HistoryBinaryFile[] } {
  const captured = copyImageGenerationSnapshot({ snapshot });
  const binaryObjectId = generateId<BinaryObjectId>();
  return { record: { id: captured.id, createdAt: captured.createdAt, request: captured.request,
    result: { confirmation: 'unconfirmed', binaryObjectId, width: output.width, height: output.height,
      modelVersion: output.reported?.modelVersion, uniformOutput: output.reported?.uniformOutput, elapsedMs }, previews: [] },
  files: [...captured.inputFiles, { binaryObjectId, blob: output.png, name: 'recovered-image.png' }] };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
