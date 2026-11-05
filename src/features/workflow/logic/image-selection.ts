import type { BrowserImageModelSelection } from '@/01-models/types';
import type { ImageLibraryView } from '@/features/stable-diffusion-cpp-browser/library-view';
import type { ImageLoraSelection } from '@/features/stable-diffusion-cpp-browser/lora-form';
import { workflowImageModelSchema } from './image-model-schema';

/** Freeze the resolved component choices, including explicit optional omissions.
 * The normal image page may keep automatic preferences; a Workflow must not
 * change its approved model composition on the next inventory refresh.
 */
export function captureWorkflowImageSelection({ library, loras }: {
  library: Pick<ImageLibraryView, 'captureModelSelection' | 'selectedModels' | 'components' | 'historyFileLocation'>,
  loras: ImageLoraSelection[],
}): BrowserImageModelSelection {
  const captured = library.captureModelSelection({ loras });
  const models = library.selectedModels();
  if (!captured || !models) {
    throw new Error('Select available local model files before applying the image selection.');
  }
  const components: BrowserImageModelSelection['components'] = library.components.value.map(component => {
    const slot = component.slot;
    switch (slot) {
    case 'model': case 'diffusion': throw new Error('A primary model is not an image component.');
    case 'vae': case 'clipL': case 'clipG': case 't5': case 'lm': break;
    default: {
      const exhaustive: never = slot;
      throw new Error(String(exhaustive));
    }
    }
    const selected = models.find(model => model.slot === component.slot);
    if (!selected) {
      return { slot, choice: { kind: 'none' } };
    }
    const location = library.historyFileLocation({ file: selected.file });
    switch (location.type) {
    case 'file': throw new Error('Workflow models must come from the local model library.');
    case 'opfs': case 'temp': return { slot, choice: { kind: 'file', location: { kind: location.type, path: location.path } } };
    case 'host': return { slot, choice: { kind: 'file', location: { kind: 'host', path: location.path, directoryId: location.directoryId } } };
    default: {
      const exhaustive: never = location;
      throw new Error(String(exhaustive));
    }
    }
  });
  return workflowImageModelSchema.parse({ ...captured, components });
}

export const TEST_ONLY = {
};
