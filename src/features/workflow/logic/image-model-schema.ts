import { z } from 'zod';
import { toHostModelDirectoryId, idToRaw } from '@/01-models/ids';
import type { BrowserImageModelLocation, BrowserImageModelSelection } from '@/01-models/types';
import { validModelPath } from '@/features/stable-diffusion-cpp-browser/logic/model-path';

const pathSchema = z.string().min(1).max(4096).refine(path => validModelPath({ path }), 'Model path must be safe and relative.');
const locationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('opfs'), path: pathSchema.refine(path => path.startsWith('models/')) }),
  z.object({ kind: z.literal('temp'), path: pathSchema.refine(path => path.startsWith('temp/')) }),
  z.object({ kind: z.literal('host'), directoryId: z.string().min(1).max(256).transform(raw => toHostModelDirectoryId({ raw })), path: pathSchema }),
]);
const componentSlotSchema = z.enum(['vae', 'clipL', 'clipG', 't5', 'lm']);
/** A persisted selection is a locator, not a claim of content identity or authority. */
export const workflowImageModelSchema = z.object({
  primary: z.object({ slot: z.enum(['model', 'diffusion']), location: locationSchema }),
  components: z.array(z.object({
    slot: componentSlotSchema,
    choice: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('file'), location: locationSchema }),
      z.object({ kind: z.literal('none') }),
    ]),
  })).max(5),
  loras: z.array(z.object({ location: locationSchema, enabled: z.enum(['enabled', 'disabled']), strength: z.number().finite().min(-10).max(10) })).max(16),
}).superRefine((value, context) => {
  if (new Set(value.components.map(component => component.slot)).size !== value.components.length) {
    context.addIssue({ code: 'custom', path: ['components'], message: 'Each image component slot must appear only once.' });
  }
}) satisfies z.ZodType<BrowserImageModelSelection>;

export function workflowImageLocationLabel({ location }: { location: BrowserImageModelLocation }): string {
  switch (location.kind) {
  case 'opfs': case 'temp': return `${location.kind}: ${location.path}`;
  case 'host': return `host (${idToRaw({ id: location.directoryId })}): ${location.path}`;
  default: {
    const exhaustive: never = location;
    throw new Error(String(exhaustive));
  }
  }
}

export const TEST_ONLY = {
};
