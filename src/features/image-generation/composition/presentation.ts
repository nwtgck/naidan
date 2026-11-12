import { idToRaw, type ImageGenerationRunId } from '@/01-models/ids';
import type { ImageGenerationOperation, ImageGenerationRunSummary, ImageGenerationAssetPage } from '@/01-models/image-generation';
type RunGroup = { run: ImageGenerationRunSummary, images: ImageGenerationAssetPage['items'] };
export type ImageOperationGroup = { key: string, operation: ImageGenerationOperation | undefined, groups: RunGroup[] };

/** Filter at the existing Run level, then group visible requests without losing
 * their distinct prompt headings. Accepted request order is not timestamp order. */
export function groupImageGenerationOperations({ groups, operations }: { groups: RunGroup[], operations: ImageGenerationOperation[] }): ImageOperationGroup[] {
  const byId = new Map(groups.map(group => [group.run.id, group]));
  const claimed = new Set<ImageGenerationRunId>();
  const result: ImageOperationGroup[] = [];
  for (const operation of operations) {
    const members = operation.runIds.flatMap(id => {
      const group = byId.get(id);
      if (!group || claimed.has(id)) {
        return [];
      }
      claimed.add(id);
      return [group];
    });
    if (members.length) {
      result.push({ key: idToRaw({ id: operation.id }), operation, groups: members });
    }
  }
  for (const group of groups) {
    if (!claimed.has(group.run.id)) {
      result.push({ key: `unaccepted:${idToRaw({ id: group.run.id })}`, operation: undefined, groups: [group] });
    }
  }
  return result.sort((a, b) => (b.operation?.createdAt ?? b.groups[0]!.run.createdAt) - (a.operation?.createdAt ?? a.groups[0]!.run.createdAt) || a.key.localeCompare(b.key));
}

export const TEST_ONLY = {
};
