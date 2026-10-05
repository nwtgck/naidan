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

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
