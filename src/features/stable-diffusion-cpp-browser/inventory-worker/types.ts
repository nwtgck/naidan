import { temporaryRootIdSchema } from '@/01-models/temporary-model-files';
import { z } from 'zod';
import type { WorkerProxy } from '@/utils/worker-transport';
import type { ModelInventory } from '@/features/stable-diffusion-cpp-browser/logic/model-candidates';
import type { LocalImageRepository, HostImageDirectory } from '@/features/stable-diffusion-cpp-browser/logic/repository-store';
export const inspectionProgressSchema = z.object({
  phase: z.enum(['listing', 'headers']),
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  path: z.string().max(2048),
}).strict();
export const inspectionRepositoryIdsSchema = z.array(z.string().min(1).max(4096).refine(id => id.startsWith('user/') || id.startsWith('huggingface.co/') || temporaryRootIdSchema.safeParse(id).success, 'Only OPFS publications and temporary roots can use a targeted scan.')).max(256);
export type InspectionProgress = z.infer<typeof inspectionProgressSchema>;
export type InspectionReport = ({ progress }: { progress: InspectionProgress }) => void;
export interface InventoryWorker {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Proxied callback must be a top-level Comlink argument.
  inspect(repositories: LocalImageRepository[] | undefined, report: WorkerProxy<InspectionReport>, hostDirectories?: HostImageDirectory[], repositoryIds?: string[], temporaryRepositories?: LocalImageRepository[]): Promise<ModelInventory>;
}
export const TEST_ONLY = {
};
