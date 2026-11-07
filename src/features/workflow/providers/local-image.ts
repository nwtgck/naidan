import { rawConfiguration, createImageEngineClient, initialProfile, supportsJspi, supportsMemory64, inspectImageInventory } from '@/features/image-generation/providers/local-environment';
import { configurationSchema, getProfileConfiguration, requestSchema } from '@/features/stable-diffusion-cpp-browser/types';
import type { ImageClient } from '@/features/stable-diffusion-cpp-browser/worker/types';
import type { ModelInventory } from '@/features/stable-diffusion-cpp-browser/logic/model-candidates';
import { temporaryImageRepositories, restoreTemporaryImageFiles } from '@/features/stable-diffusion-cpp-browser/logic/temporary-repositories';
import { temporaryModelFiles } from '@/logic/temporary-model-files';
import { resolveWorkflowImageModels } from '@/features/workflow/logic/image-models';
import { validateWorkflowImageDimensions } from '@/features/workflow/logic/image-files';
import type { WorkflowImageEngine } from '@/features/workflow/logic/image-generation';

/** One owner and inspected File snapshot per Workflow run. No Vue editor state,
 * downloads, permission requests, or automatic model selection at execution time.
 * This module is loaded only after the exact local model selection is approved.
 */
export function createWorkflowImageProvider({ directories }: { directories: { directoryId: string, directoryName: string }[] }) {
  let client: ImageClient | undefined;
  let inventory: ModelInventory | undefined;
  let closed = false;
  let active = false;
  const generate: WorkflowImageEngine = async ({ request, signal, onProgress, onPreview }) => {
    signal.throwIfAborted();
    if (closed || active) {
      throw new Error('Workflow image provider is closed or already generating.');
    }
    active = true;
    try {
      const configuration = configurationSchema.parse(rawConfiguration);
      switch (configuration.kind) {
      case 'unavailable': throw new Error('Local image inference is not included in this build.');
      case 'available': break;
      default: {
        const exhaustive: never = configuration;
        throw new Error(String(exhaustive));
      }
      }
      const { profile: selectedProfile, weightResidency, ...parameters } = request.parameters;
      const profile = (() => {
        switch (selectedProfile) {
        case 'auto': return initialProfile();
        case 'webgpu-wasm32-asyncify': case 'webgpu-wasm32-jspi': case 'webgpu-wasm64-jspi': return selectedProfile;
        default: {
          const exhaustive: never = selectedProfile;
          throw new Error(String(exhaustive));
        }
        }
      })();
      const artifact = configuration.artifacts.find(artifact => artifact.profile === profile);
      const capabilities = getProfileConfiguration({ profile });
      if (!artifact || capabilities.jspi && !supportsJspi() || capabilities.memory64 && !supportsMemory64()) {
        throw new Error('The selected local image runtime profile is unavailable in this browser.');
      }
      if (request.imageInputs !== undefined) {
        await validateWorkflowImageDimensions({
          files: [...(request.imageInputs.initImage === undefined ? [] : [request.imageInputs.initImage]), ...request.imageInputs.referenceImages],
          signal,
          decode: ({ image }) => createImageBitmap(image),
        });
      }
      if (!inventory) {
        const roots = temporaryModelFiles.list();
        const inspected = await inspectImageInventory({
          signal,
          onProgress: () => undefined,
          hostDirectories: directories,
          temporaryRepositories: temporaryImageRepositories({ roots }),
        });
        signal.throwIfAborted();
        if (roots.some(root => temporaryModelFiles.get({ rootPath: root.rootPath }) !== root)) {
          throw new Error('Temporary image model files changed during inspection.');
        }
        inventory = restoreTemporaryImageFiles({ inventory: inspected, roots });
      }
      const { models, loras } = resolveWorkflowImageModels({ selection: request.model, inventory });
      const nativeRequest = requestSchema.parse({
        debug: 'off',
        artifact,
        baseUrl: new URL(import.meta.env.BASE_URL, document.baseURI).href,
        models,
        loras,
        parameters: { ...parameters, prompt: request.prompt },
        weightResidency,
        gpuBudgetMiB: request.gpuBudgetMiB,
        imageInputs: request.imageInputs,
        preview: request.preview,
      });
      signal.throwIfAborted();
      client ??= createImageEngineClient({ onReleased: undefined });
      const result = await client.generate({ request: nativeRequest, signal, onProgress, onPreview });
      signal.throwIfAborted();
      return { result, profile };
    } finally {
      active = false;
    }
  };
  function close(): void {
    if (active) {
      throw new Error('Await image generation before retiring its owner.');
    }
    closed = true;
    inventory = undefined;
    // This existing owned-engine API releases only this Workflow's resources.
    const retiring = client;
    client = undefined;
    retiring?.dispose();
  }
  return { generate, close };
}

export const TEST_ONLY = {
};
