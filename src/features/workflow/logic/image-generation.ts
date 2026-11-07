import { previewFrameSchema, profileSchema, workerResultSchema, type Progress, type Artifact, type PreviewFrame } from '@/features/stable-diffusion-cpp-browser/types';
import type { WorkflowImageGenerationInput, WorkflowOutputs } from './runtime';
import type { WorkflowImageRequest } from './image-input';
import { workflowImageRequestSchema } from './image-input';
import { readWorkflowImageFile, WORKFLOW_IMAGE_FILES_LIMIT, WORKFLOW_IMAGE_REFERENCE_LIMIT } from './image-files';
import type { WorkflowOutput } from './output-store';

export type WorkflowImageEngine = ({ request, signal, onProgress, onPreview }: {
  request: WorkflowImageRequest, signal: AbortSignal, onProgress: ({ event }: { event: Progress }) => void,
  onPreview?: ({ frame }: { frame: PreviewFrame }) => void,
}) => Promise<{ result: unknown, profile: Artifact['profile'] }>;

/** The engine owns its worker until physical cancellation is acknowledged. Never
 * race this operation with Stop: that could abandon the shared inference lane.
 */
export async function generateWorkflowImage({ input, generate, onProgress, onPreview }: {
  input: WorkflowImageGenerationInput, generate: WorkflowImageEngine, onProgress: ({ event }: { event: Progress }) => void,
  onPreview?: ({ frame }: { frame: PreviewFrame }) => void,
}): Promise<WorkflowOutputs> {
  const { signal, store } = input;
  signal.throwIfAborted();
  const request = workflowImageRequestSchema.parse(input.request);
  if (input.images !== undefined) {
    const { initImage, referenceImages, strength } = input.images;
    const values = [...(initImage === undefined ? [] : [initImage]), ...referenceImages];
    if (referenceImages.length > WORKFLOW_IMAGE_REFERENCE_LIMIT || values.reduce((sum, value) => sum + value.output.byteLength, 0) > WORKFLOW_IMAGE_FILES_LIMIT) {
      throw new Error('Image inputs exceed eight references or 64 MiB in total.');
    }
    const initial = initImage === undefined ? undefined : await readWorkflowImageFile({ value: initImage, signal });
    const references: File[] = [];
    for (const value of referenceImages) {
      references.push(await readWorkflowImageFile({ value, signal }));
    }
    request.imageInputs = { initImage: initial, referenceImages: references, strength };
  }
  // A preview has no output lease and is never an exportable completed result.
  let accepting = true;
  let previewRun: number | undefined;
  let previousRevision = -1;
  let previousStep = -1;
  let generated: Awaited<ReturnType<WorkflowImageEngine>>;
  try {
    generated = await generate({
      request: workflowImageRequestSchema.parse(request),
      signal,
      onProgress,
      onPreview: ({ frame }) => {
        if (!accepting || signal.aborted || !request.preview?.enabled || !onPreview) {
          return;
        }
        const parsed = previewFrameSchema.safeParse(frame);
        if (!parsed.success) {
          return;
        }
        const value = parsed.data;
        if (previewRun !== undefined && value.runId !== previewRun
          || value.revision < previousRevision
          || value.revision === previousRevision && value.step <= previousStep
          || value.steps > request.parameters.steps || value.step > value.steps
          || value.mode !== request.preview.mode
          || request.preview.maxEdge > 0 && (value.width > request.preview.maxEdge || value.height > request.preview.maxEdge)) {
          return;
        }
        previewRun = value.runId;
        previousRevision = value.revision;
        previousStep = value.step;
        onPreview({ frame: value });
      },
    });
  } finally {
    accepting = false;
  }
  signal.throwIfAborted();
  const result = workerResultSchema.parse(generated.result);
  const profile = profileSchema.parse(generated.profile);
  if ('cancelled' in result) {
    throw new Error('Image generation stopped without a completed output.');
  }
  if (result.width !== request.parameters.width || result.height !== request.parameters.height) {
    throw new Error('Generated image dimensions do not match the request.');
  }
  const header = new Uint8Array(await result.png.slice(0, 33).arrayBuffer());
  signal.throwIfAborted();
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (header.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte)
    || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452
    || view.getUint32(16) !== result.width || view.getUint32(20) !== result.height) {
    throw new Error('Generated image has an invalid PNG header or dimensions.');
  }
  const writer = await store.createWriter({ signal });
  let output: WorkflowOutput | undefined;
  try {
    for (let offset = 0; offset < result.png.size; offset += 32768) {
      signal.throwIfAborted();
      await writer.write({ chunk: new Uint8Array(await result.png.slice(offset, offset + 32768).arrayBuffer()) });
    }
    output = await writer.seal();
    signal.throwIfAborted();
    return {
      image: { type: 'binary', output, format: 'png' },
      metadata: { type: 'json', value: { width: result.width, height: result.height, modelVersion: result.modelVersion, uniformOutput: result.uniformOutput, byteLength: result.png.size, requestedSeed: request.parameters.seed, profile } },
    };
  } catch (reason) {
    if (output) {
      await output.release();
    } else {
      await writer.abort({ reason });
    }
    throw reason;
  }
}

export const TEST_ONLY = {
};
