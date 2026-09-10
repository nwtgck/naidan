import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readModelFixture } from '@/features/transformers-js/replay-models/support/model-runtime-fixture';
import { createSyntheticModelBody } from '@/features/transformers-js/replay-models/support/download-synthetic-session-oracle';
import { hostedTransformersRuntimeAssetManifestEntry, HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST } from '@/features/transformers-js/runtime/runtime-asset-manifest';
import type { HostedTransformersRuntimeAssetUrls } from '@/features/transformers-js/runtime/configure-hosted-runtime';

/** No socket fallback. Metadata is original; model bodies and their sizes are synthetic controls. */
export function createInvestigationFullFlowTestHttp({ models, assets, externalNetworkPolicy, repositoryRevisions }: {
  models: ReadonlyArray<{ modelId: string; revision: string }>;
  assets: HostedTransformersRuntimeAssetUrls;
  externalNetworkPolicy: 'allow' | 'deny';
  repositoryRevisions: ReadonlyMap<string, string>;
}) {
  const manifest = hostedTransformersRuntimeAssetManifestEntry({ variant: assets.variant });
  const runtimeBytes = new Map([
    [assets.mjsUrl, { bytes: Uint8Array.from(readFileSync(resolve(process.cwd(), 'node_modules/onnxruntime-web/dist', manifest.sourceMjsFileName))), type: 'text/javascript' }],
    [assets.wasmUrl, { bytes: Uint8Array.from(readFileSync(resolve(process.cwd(), 'node_modules/onnxruntime-web/dist', manifest.sourceWasmFileName))), type: 'application/wasm' }],
  ]);
  const repositories = models.map(model => {
    const fixture = readModelFixture({ modelId: model.modelId });
    if (fixture.summary.revision !== model.revision) throw new Error('Full control fixture revision mismatch');
    const files = new Map(fixture.files);
    for (const artifact of fixture.repository.files) files.set(artifact.path, createSyntheticModelBody({ modelId: model.modelId, revision: model.revision, path: artifact.path }));
    // A revision-advance control changes only the remote commit identity. The
    // repository-owned metadata bytes and independently seeded OPFS stay intact.
    return { ...model, revision: repositoryRevisions.get(model.modelId) ?? model.revision, files,
      absent: new Set(fixture.summary.files.filter(file => file.status === 'repository-absent').map(file => file.path)) };
  });
  const requests: Array<{ url: string; method: string; range: string | undefined }> = [];
  const unknown: string[] = [];
  const fixtureFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const { url, method } = request;
    const range = request.headers.get('range') ?? undefined;
    requests.push({ url, method, range });
    const runtime = runtimeBytes.get(url);
    if (runtime !== undefined && method === 'GET') return new Response(runtime.bytes, { headers: { 'Content-Type': runtime.type } });
    if (assets.manifestUrl !== undefined && url === assets.manifestUrl && method === 'GET') return new Response(JSON.stringify(HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST), { headers: { 'Content-Type': 'application/json' } });
    switch (externalNetworkPolicy) {
    case 'deny': break;
    case 'allow': {
      for (const repository of repositories) {
        if (url === `https://huggingface.co/api/models/${repository.modelId}/revision/main?blobs=true` && method === 'GET') {
          return new Response(JSON.stringify({ sha: repository.revision, private: false, gated: false, pipeline_tag: 'image-text-to-text', library_name: 'transformers',
            siblings: [...repository.files].map(([path, bytes]) => ({ rfilename: path, size: bytes.byteLength })) }), { headers: { 'Content-Type': 'application/json' } });
        }
        const prefix = `https://huggingface.co/${repository.modelId}/resolve/${repository.revision}/`;
        if (!url.startsWith(prefix)) continue;
        const path = url.slice(prefix.length);
        if (repository.absent.has(path) && method === 'GET') return new Response('Recorded absent metadata', { status: 404 });
        const bytes = repository.files.get(path);
        if (bytes === undefined) continue;
        const headers = { 'Content-Type': path.endsWith('.json') ? 'application/json' : 'application/octet-stream', 'Content-Length': String(bytes.byteLength), 'Accept-Ranges': 'bytes' };
        if (method === 'HEAD') return new Response(undefined, { headers });
        if (method !== 'GET') continue;
        if (range !== undefined) {
          const match = /^bytes=(\d+)-(\d+)$/u.exec(range);
          if (match === null) continue;
          const start = Number(match[1]); const end = Math.min(Number(match[2]), bytes.byteLength - 1);
          if (start > end || end - start + 1 > 32 * 1024) continue;
          return new Response(bytes.slice(start, end + 1), { status: 206, headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}` } });
        }
        // Even this finite test server refuses full model bodies. The actual
        // investigation transport must express HEAD or bounded-range authority.
        if (!path.startsWith('onnx/')) return new Response(Uint8Array.from(bytes), { headers });
      }
      break;
    }
    default: { const exhaustive: never = externalNetworkPolicy; throw new Error('Unknown fixture network policy: ' + exhaustive); }
    }
    unknown.push(`${method} ${url} ${range ?? ''}`);
    throw new Error(`Unprovided Full fixture HTTP request: ${method} ${url}`);
  };
  return { fetch: fixtureFetch, requests, unknown };
}

export const TEST_ONLY = {
};
