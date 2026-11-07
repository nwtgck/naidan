import type { BrowserImageModelSelection } from '@/01-models/types';
import { createWorkflowTargetPermissions } from './model-permissions';
import { workflowImageModelSchema, workflowImageLocationLabel } from './image-model-schema';

/** Separate from text/audio even when a local file or model name is identical. */
export function createWorkflowImagePermissions() {
  return createWorkflowTargetPermissions<BrowserImageModelSelection>({
    targetIdentity: ({ target }) => JSON.stringify(workflowImageModelSchema.parse(target)),
    describe({ target, scope, sources }) {
      const selection = workflowImageModelSchema.parse(target);
      const modelId = [
        `${selection.primary.slot}: ${workflowImageLocationLabel({ location: selection.primary.location })}`,
        ...selection.components.map(component => {
          const choice = component.choice;
          switch (choice.kind) {
          case 'none': return `${component.slot}: —`;
          case 'file': return `${component.slot}: ${workflowImageLocationLabel({ location: choice.location })}`;
          default: {
            const exhaustive: never = choice;
            throw new Error(String(exhaustive));
          }
          }
        }),
        ...selection.loras.map(lora => `LoRA (${lora.enabled}, ${lora.strength}): ${workflowImageLocationLabel({ location: lora.location })}`),
      ].join('\n');
      return { endpoint: 'stable-diffusion.cpp browser', modelId, headerNames: [], scope, sources: sources.length ? [...new Set(sources)] : ['unknown'] };
    },
  });
}

export const TEST_ONLY = {
};
