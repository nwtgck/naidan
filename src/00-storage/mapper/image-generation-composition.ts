import { idToRaw, toImageGenerationSessionId } from '@/01-models/ids';
import type { ExperimentalImageGenerationCompositionDto, ExperimentalImageGenerationModelConfigurationDto } from '@/00-storage/00-dto/experimental-image-generation.dto';
import type { ImageCompositionDraft, ImageModelConfiguration } from '@/01-models/image-generation';
import { imageGenerationModelFileToDto, imageGenerationModelFileToDomain, imageGenerationRuntimeToDto, imageGenerationRuntimeToDomain } from './image-generation-history';
import { imageInferenceLocationToDto, imageInferenceLocationToDomain, remoteImageModelEditorToDto, remoteImageModelEditorToDomain } from './image-generation-editor';
import { browserImageModelSelectionToDto, browserImageModelSelectionToDomain } from './browser-image-model-selection';

export function imageModelConfigurationToDto({ configuration }: { configuration: ImageModelConfiguration }): ExperimentalImageGenerationModelConfigurationDto {
  const { request, inferenceLocation, modelSelection, remoteModelEditor, loraStates, layout, ...unhandledConfiguration } = configuration;
  unhandledConfiguration satisfies Record<PropertyKey, never>;
  const { models, loras, runtime, ...unhandled } = request;
  unhandled satisfies Record<PropertyKey, never>;
  return {
    layout,
    request: {
      models: models.map(({ file, companions, ...model }) => ({ ...model, file: imageGenerationModelFileToDto({ file }), companions: companions.map(({ file, ...companion }) => ({ ...companion, file: imageGenerationModelFileToDto({ file }) })) })),
      loras: loras.map(({ file, ...lora }) => ({ ...lora, file: imageGenerationModelFileToDto({ file }) })),
      runtime: runtime && imageGenerationRuntimeToDto({ runtime }),
    },
    inferenceLocation: inferenceLocation && imageInferenceLocationToDto({ location: inferenceLocation }),
    modelSelection: modelSelection && browserImageModelSelectionToDto({ domain: modelSelection }),
    remoteModelEditor: remoteModelEditor && remoteImageModelEditorToDto({ editor: remoteModelEditor }),
    loraStates: loraStates.map(state => ({ ...state })),
  };
}

export function imageModelConfigurationToDomain({ dto }: { dto: ExperimentalImageGenerationModelConfigurationDto }): ImageModelConfiguration {
  const { request, inferenceLocation, modelSelection, remoteModelEditor, loraStates, layout, ...unhandledConfiguration } = dto;
  unhandledConfiguration satisfies Record<PropertyKey, never>;
  const { models, loras, runtime, ...unhandled } = request;
  unhandled satisfies Record<PropertyKey, never>;
  return {
    layout,
    request: {
      models: models.map(({ file, companions, ...model }) => ({ ...model, file: imageGenerationModelFileToDomain({ file }), companions: companions.map(({ file, ...companion }) => ({ ...companion, file: imageGenerationModelFileToDomain({ file }) })) })),
      loras: loras.map(({ file, ...lora }) => ({ ...lora, file: imageGenerationModelFileToDomain({ file }) })),
      runtime: runtime && imageGenerationRuntimeToDomain({ runtime }),
    },
    inferenceLocation: inferenceLocation && imageInferenceLocationToDomain({ dto: inferenceLocation }),
    modelSelection: modelSelection && browserImageModelSelectionToDomain({ dto: modelSelection }),
    remoteModelEditor: remoteModelEditor && remoteImageModelEditorToDomain({ dto: remoteModelEditor }),
    loraStates: loraStates.map(state => ({ ...state })),
  };
}

export function imageCompositionToDto({ draft }: { draft: ImageCompositionDraft }): ExperimentalImageGenerationCompositionDto {
  const { sessionId, mode, revision, updatedAt, jobs, slots, ...unhandled } = draft;
  unhandled satisfies Record<PropertyKey, never>;
  return {
    version: 1,
    sessionId: idToRaw({ id: sessionId }),
    mode,
    revision,
    updatedAt,
    jobs: jobs.map(({ id, input }) => ({ id, input: { ...input } })),
    slots: slots.map(({ name, configuration }) => ({ name, configuration: imageModelConfigurationToDto({ configuration }) })),
  };
}

export function imageCompositionToDomain({ dto }: { dto: ExperimentalImageGenerationCompositionDto }): ImageCompositionDraft {
  const { version: _version, sessionId, mode, revision, updatedAt, jobs, slots, ...unhandled } = dto;
  unhandled satisfies Record<PropertyKey, never>;
  return {
    sessionId: toImageGenerationSessionId({ raw: sessionId }),
    mode,
    revision,
    updatedAt,
    jobs: jobs.map(({ id, input }) => ({ id, input: { ...input } })),
    slots: slots.map(({ name, configuration }) => ({ name, configuration: imageModelConfigurationToDomain({ dto: configuration }) })),
  };
}

export const TEST_ONLY = {
};
