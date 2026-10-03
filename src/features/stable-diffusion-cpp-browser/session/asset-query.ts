import type { ImageGenerationAssetPage, ImageGenerationAssetQuery, ImageGenerationAssetSummary, ImageGenerationAssetAnnotations, ImageGenerationReadResult, ImageGenerationRunSummary } from '@/01-models/image-generation';
import { imageGenerationTagReferenceKey } from '@/01-models/image-generation';
import { idToRaw } from '@/01-models/ids';

function compareIds({ a, b }: { a: string, b: string }): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A projection over one storage snapshot, not another source of truth.
 * The query Worker validates its incoming query before calling this function. */
export function selectImageGenerationAssets({ snapshot, query }: {
  snapshot: { assets: ImageGenerationReadResult<ImageGenerationAssetSummary>, annotations: ImageGenerationReadResult<ImageGenerationAssetAnnotations>, runs: ImageGenerationReadResult<ImageGenerationRunSummary> },
  query: ImageGenerationAssetQuery,
}): ImageGenerationAssetPage {
  const { assets, annotations, runs } = snapshot;
  const byAsset = new Map(annotations.items.map(item => [item.assetId, item]));
  const byRun = new Map(runs.items.map(item => [item.id, item]));
  const keys = query.tags.map(tag => imageGenerationTagReferenceKey({ tag }));
  const words = query.text.normalize('NFC').toLowerCase().trim().split(/\s+/).filter(Boolean);
  let warningCount = assets.warningCount + annotations.warningCount + runs.warningCount;
  const warnings = [
    ...assets.warnings.map(warning => ({ ...warning, path: `assets/${warning.path}` })),
    ...annotations.warnings.map(warning => ({ ...warning, path: `annotations/${warning.path}` })),
    ...runs.warnings.map(warning => ({ ...warning, path: `runs/${warning.path}` })),
  ].slice(0, 100);
  const matches = assets.items.filter(asset => {
    const state = byAsset.get(asset.id)?.state ?? 'active';
    switch (state) {
    case 'deleting': case 'deleted': return false;
    case 'active': case 'archived': break;
    default: { const exhaustive: never = state; throw new Error(String(exhaustive)); }
    }
    if (query.visibility !== 'all' && state !== query.visibility) return false;
    if (query.runId !== undefined && asset.runId !== query.runId) return false;
    const run = byRun.get(asset.runId);
    if (!run) {
      warningCount++;
      if (warnings.length < 100) warnings.push({ path: `runs/${idToRaw({ id: asset.runId })}`, message: 'The originating run is unavailable.' });
    }
    const haystack = `${run?.prompt ?? ''}\n${run?.modelName ?? ''}`.normalize('NFC').toLowerCase();
    if (!words.every(word => haystack.includes(word))) return false;
    const assigned = new Set((byAsset.get(asset.id)?.tags ?? []).map(item => imageGenerationTagReferenceKey({ tag: item.tag })));
    if (!keys.length) return true;
    switch (query.match) {
    case 'all': return keys.every(key => assigned.has(key));
    case 'any': return keys.some(key => assigned.has(key));
    default: { const exhaustive: never = query.match; throw new Error(String(exhaustive)); }
    }
  });
  matches.sort((a, b) => b.createdAt - a.createdAt || compareIds({ a: idToRaw({ id: a.id }), b: idToRaw({ id: b.id }) }));
  const remaining = matches.filter(item => !query.cursor || item.createdAt < query.cursor.createdAt || item.createdAt === query.cursor.createdAt && compareIds({ a: idToRaw({ id: item.id }), b: idToRaw({ id: query.cursor.id }) }) > 0);
  const items = remaining.slice(0, query.limit).map(asset => ({ ...asset, annotations: byAsset.get(asset.id)
    ?? (annotations.warningCount ? undefined : { assetId: asset.id, sessionId: asset.sessionId, revision: 0, state: 'active' as const, tags: [] }) }));
  const last = items.at(-1);
  return { items, warnings, warningCount, total: matches.length, nextCursor: remaining.length > items.length && last ? { createdAt: last.createdAt, id: last.id } : undefined };
}
export const TEST_ONLY = {
};
