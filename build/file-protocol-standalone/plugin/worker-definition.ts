import path from 'node:path';
import type { NaidanStandaloneWorkerDefinition } from '../plugin-types.js';

export type NormalizedWorkerDefinition = NaidanStandaloneWorkerDefinition & Readonly<{entry: string}>;

export function normalizeWorkerDefinitions({
  workers,
}: Readonly<{
  workers: readonly NaidanStandaloneWorkerDefinition[];
}>): readonly NormalizedWorkerDefinition[] {
  if (!Array.isArray(workers) || workers.length === 0) {
    throw new TypeError('workers must be a non-empty array');
  }

  const workerDefinitions: readonly NaidanStandaloneWorkerDefinition[] = workers;
  const normalizedWorkers = workerDefinitions.map(worker => {
    if (!worker?.name || !worker?.entry || !worker?.virtualId) {
      throw new TypeError('Each Worker requires name, entry, and virtualId');
    }
    return { ...worker, entry: path.resolve(worker.entry) };
  });
  const seenVirtualIds = new Set<string>();
  const seenNames = new Set<string>();
  const seenEntries = new Set<string>();
  for (const worker of normalizedWorkers) {
    if (seenVirtualIds.has(worker.virtualId)) throw new Error(`Duplicate Worker virtualId: ${worker.virtualId}`);
    if (seenNames.has(worker.name)) throw new Error(`Duplicate Worker name: ${worker.name}`);
    if (seenEntries.has(worker.entry)) throw new Error(`Duplicate Worker entry: ${worker.entry}`);
    seenVirtualIds.add(worker.virtualId);
    seenNames.add(worker.name);
    seenEntries.add(worker.entry);
  }

  return normalizedWorkers;
}
