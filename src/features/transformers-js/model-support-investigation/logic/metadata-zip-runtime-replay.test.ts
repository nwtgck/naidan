import JSZip from 'jszip';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDownloadedModelReadOnlyCache } from '@/features/transformers-js/runtime/downloaded-model-cache';
import { createDownloadedModelWorkerFetch } from '@/features/transformers-js/runtime/offline-worker-fetch';
import { selectTransformersJsProductionRuntimeArtifactLoader } from '@/features/transformers-js/production-routing';
import { getProductionTransformersArtifact, importProductionTransformersArtifact } from '@/features/transformers-js/runtime/fixtures/production-transformers-artifact';
import type { OpfsModelCacheMatchObservation } from '@/features/transformers-js/runtime/opfs-model-cache';
import { collectReplayMetadata, replayMetadataSha256, replayMetadataSummarySchema, type InvestigationReplayMetadataSnapshot } from './collect-replay-metadata';
import { createPartialModelSupportEvidence, createBatchModelSupportEvidence } from './create-partial-evidence';
import { createInitialInvestigationCheckpoint } from './investigation-recovery';
import corpusJson from './fixtures/replay-metadata-corpus.json';

const REVISION = 'a'.repeat(40);
const MODEL_ID = 'fixture/replay';
const corpus = z.object({ models: z.array(z.object({
  modelId: z.string(), revision: z.string(),
  declarations: z.array(z.object({ path: z.string(), value: z.record(z.string(), z.unknown()) })),
})) }).parse(corpusJson).models;

// Entirely synthetic, deliberately tiny. This proves the ZIP-to-runtime
// connection, not any public model's tokenizer outputs or model compatibility.
const toyBodies = {
  'tokenizer_config.json': JSON.stringify({ tokenizer_class: 'PreTrainedTokenizer', unk_token: '[UNK]', chat_template: "{% for message in messages %}{{ message['content'] }}{% endfor %}" }),
  'tokenizer.json': JSON.stringify({
    version: '1.0', added_tokens: [], normalizer: null,
    pre_tokenizer: { type: 'WhitespaceSplit' }, post_processor: null, decoder: null,
    model: { type: 'WordLevel', vocab: { '[UNK]': 0, hello: 1, world: 2 }, unk_token: '[UNK]' },
  }),
  'preprocessor_config.json': '{ "processor_class": "Gemma4Processor" }',
  'processor_config.json': '{}',
  'chat_template.jinja': "{% for message in messages %}{{ message['content'] }}{% endfor %}",
};

afterEach(() => vi.unstubAllGlobals());

async function capture({ modelId, revision, bodies }: { modelId: string, revision: string, bodies: Record<string, string> }): Promise<InvestigationReplayMetadataSnapshot> {
  const files = new Map(Object.entries(bodies).map(([path, text]) => {
    const bytes = new TextEncoder().encode(text);
    const blob = new Blob([bytes]);
    // jsdom lacks Blob.stream(); preserve its Blob identity for Zod validation.
    Object.defineProperty(blob, 'stream', { value: () => new Response(bytes).body! });
    return [path, blob] as const;
  }));
  return await collectReplayMetadata({
    modelId, revision, files: [...files].map(([path, blob]) => ({ path, size: blob.size })),
    budgetBytes: 1024 * 1024, fileTimeoutMs: 5000, modelAccess: 'public-request',
    localRead: async ({ path }) => files.get(path), remoteFetch: undefined, onSnapshot: () => undefined,
  });
}

function evidenceItem({ capture }: { capture: InvestigationReplayMetadataSnapshot }) {
  const checkpoint = createInitialInvestigationCheckpoint({ modelId: capture.summary.modelId, runId: `replay-${capture.summary.modelId}`, now: () => '2026-09-08T00:00:00.000Z' });
  return {
    target: capture.summary.modelId, status: 'failed' as const,
    run: { ...checkpoint.run, replayMetadata: capture.summary }, recovery: checkpoint.recovery,
    replayMetadata: capture.sidecars, error: undefined,
  };
}

// Reader for these bounded test-generated archives, not an application ZIP
// import API. It never fills missing entries with invented JSON or body bytes.
async function restore({ zip, prefix }: { zip: JSZip, prefix: string }) {
  const index = zip.file(`${prefix}replay-metadata/index.json`);
  if (index === null) throw new Error('Missing replay index');
  const { replayScope: _replayScope, files, ...fields } = z.object({
    replayScope: z.string(), files: z.array(z.object({ archived: z.boolean() }).passthrough()),
  }).passthrough().parse(JSON.parse(await index.async('string')));
  const summary = replayMetadataSummarySchema.parse({ ...fields, files: files.map(({ archived: _archived, ...file }) => file) });
  const restored = new Map<string, Blob>();
  for (const file of summary.files) {
    if (!files.find(item => item.path === file.path)?.archived) continue;
    if (file.status !== 'collected') throw new Error('Archived file was not collected');
    const entry = zip.file(`${prefix}replay-metadata/files/${file.path}`);
    if (entry === null) throw new Error(`Missing archived file: ${file.path}`);
    const bytes = await entry.async('uint8array');
    if (bytes.length !== file.byteLength || await replayMetadataSha256({ bytes }) !== file.sha256) throw new Error(`Replay integrity mismatch: ${file.path}`);
    const blob = new Blob([Uint8Array.from(bytes)]);
    Object.defineProperty(blob, 'stream', { value: () => new Response(Uint8Array.from(bytes)).body! });
    restored.set(file.path, blob);
  }
  return { summary, files: restored };
}

interface RuntimeTokenizer {
  encode(text: string, options: { add_special_tokens: boolean }): number[];
  apply_chat_template(messages: Array<{ role: string, content: string }>, options: { tokenize: false }): string;
}
interface Runtime {
  env: {
    allowLocalModels: boolean; allowRemoteModels: boolean; useBrowserCache: boolean;
    useCustomCache: boolean; useWasmCache: boolean; fetch: typeof fetch;
    customCache: ReturnType<typeof createDownloadedModelReadOnlyCache>;
  };
  AutoTokenizer: { from_pretrained(modelId: string, options: { revision: string, local_files_only: true }): Promise<RuntimeTokenizer> };
  AutoProcessor: { from_pretrained(modelId: string, options: { revision: string, local_files_only: true }): Promise<{ tokenizer?: RuntimeTokenizer, apply_chat_template: RuntimeTokenizer['apply_chat_template'] }> };
}

async function runtimeFromArchive({ archive }: { archive: Awaited<ReturnType<typeof restore>> }) {
  const artifact = await getProductionTransformersArtifact();
  const forbiddenFetch = vi.fn<typeof fetch>(async () => {
    throw new Error('Internet access forbidden in runtime replay');
  });
  const guardedFetch = vi.fn(createDownloadedModelWorkerFetch({
    originalFetch: forbiddenFetch, workerLocationUrl: 'http://localhost/assets/worker.js',
    environment: 'production', userAgent: 'Vitest', vendor: '',
  }));
  vi.stubGlobal('fetch', guardedFetch);
  const blobs = new Map<string, Blob>();
  const base = `models/huggingface.co/${archive.summary.modelId}/resolve/${archive.summary.revision}`;
  for (const [path, blob] of archive.files) {
    blobs.set(`${base}/${path}`, blob);
    blobs.set(`${base}/.${path}.complete`, new Blob([]));
  }
  const mutations = vi.fn();
  const reads: string[] = [];
  const directory = ({ prefix }: { prefix: string }): FileSystemDirectoryHandle => ({
    getDirectoryHandle: async (name: string, options: FileSystemGetDirectoryOptions) => {
      if (options?.create === true) {
        mutations(); throw new Error('Directory mutation forbidden');
      }
      return directory({ prefix: `${prefix}${name}/` });
    },
    getFileHandle: async (name: string, options: FileSystemGetFileOptions) => {
      if (options?.create === true) {
        mutations(); throw new Error('File mutation forbidden');
      }
      const path = `${prefix}${name}`;
      reads.push(path);
      const blob = blobs.get(path);
      if (blob === undefined) throw new DOMException('Missing fixture file', 'NotFoundError');
      return { getFile: async () => blob, createWritable: () => {
        mutations(); throw new Error('Writes forbidden');
      } };
    },
    removeEntry: () => {
      mutations(); throw new Error('Deletes forbidden');
    },
  } as unknown as FileSystemDirectoryHandle);
  vi.stubGlobal('navigator', { userAgent: 'Vitest', vendor: '', storage: { getDirectory: async () => directory({ prefix: '' }) } });
  const url = new URL(artifact.moduleUrl);
  url.searchParams.set('metadata-replay', crypto.randomUUID());
  const runtime = await importProductionTransformersArtifact({ moduleUrl: url.href }) as Runtime;
  const observations: OpfsModelCacheMatchObservation[] = [];
  Object.assign(runtime.env, {
    allowLocalModels: true, allowRemoteModels: false, useBrowserCache: false,
    useCustomCache: true, useWasmCache: false, fetch: guardedFetch,
    customCache: createDownloadedModelReadOnlyCache({
      modelId: archive.summary.modelId, revision: archive.summary.revision,
      onMatchObservation: ({ observation }) => observations.push(observation),
    }),
  });
  return { runtime, observations, reads, mutations, forbiddenFetch, guardedFetch };
}

describe('Evidence ZIP metadata through actual Transformers.js and Naidan read-only cache', () => {
  it('replays raw tokenizer bytes, revisionless metadata probes, token IDs and chat template without internet', async () => {
    const captured = await capture({ modelId: MODEL_ID, revision: REVISION, bodies: toyBodies });
    const evidence = await createPartialModelSupportEvidence(evidenceItem({ capture: captured }));
    const zip = await JSZip.loadAsync(await evidence.blob.arrayBuffer());
    const archive = await restore({ zip, prefix: '' });
    expect(await archive.files.get('preprocessor_config.json')?.text()).toBe(toyBodies['preprocessor_config.json']);
    const h = await runtimeFromArchive({ archive });
    expect(await h.runtime.env.customCache.match(`https://huggingface.co/${MODEL_ID}/resolve/${'b'.repeat(40)}/tokenizer.json`)).toBeUndefined();
    const tokenizer = await h.runtime.AutoTokenizer.from_pretrained(MODEL_ID, { revision: REVISION, local_files_only: true });
    expect(tokenizer.encode('hello world', { add_special_tokens: false })).toEqual([1, 2]);
    expect(tokenizer.apply_chat_template([{ role: 'user', content: 'hello world' }], { tokenize: false })).toBe('hello world');
    expect(h.observations).toEqual(expect.arrayContaining([expect.objectContaining({ result: 'alias-hit', requestedPath: `huggingface.co/${MODEL_ID}/resolve/main/tokenizer_config.json` })]));
    expect(h.reads).toContain(`models/huggingface.co/${MODEL_ID}/resolve/${REVISION}/tokenizer.json`);
    expect(h.mutations).not.toHaveBeenCalled();
    expect(h.forbiddenFetch).not.toHaveBeenCalled();
    expect(h.guardedFetch).not.toHaveBeenCalled();
  });

  it('restores each batch dossier separately and reaches the actual Gemma4 processor metadata path', async () => {
    const captures = await Promise.all(['fixture/one', 'fixture/two'].map(modelId => capture({ modelId, revision: REVISION, bodies: toyBodies })));
    const evidence = await createBatchModelSupportEvidence({ batchId: 'fixture-batch', items: captures.map(capture => evidenceItem({ capture })) });
    const zip = await JSZip.loadAsync(await evidence.blob.arrayBuffer());
    const batch = z.object({ targets: z.array(z.object({ target: z.string(), evidencePath: z.string() })) }).parse(JSON.parse(await zip.file('batch.json')!.async('string')));
    for (const target of batch.targets) {
      const archive = await restore({ zip, prefix: target.evidencePath });
      expect(archive.summary.modelId).toBe(target.target);
      const h = await runtimeFromArchive({ archive });
      const processor = await h.runtime.AutoProcessor.from_pretrained(target.target, { revision: REVISION, local_files_only: true });
      expect(processor.tokenizer?.encode('hello world', { add_special_tokens: false })).toEqual([1, 2]);
      expect(processor.apply_chat_template([{ role: 'user', content: 'hello world' }], { tokenize: false })).toBe('hello world');
      for (const path of ['processor_config.json', 'preprocessor_config.json', 'chat_template.jinja', 'tokenizer.json']) {
        expect(h.reads).toContain(`models/huggingface.co/${target.target}/resolve/${REVISION}/${path}`);
      }
      expect(h.mutations).not.toHaveBeenCalled();
      expect(h.forbiddenFetch).not.toHaveBeenCalled();
    }
  });

  it('rejects missing or modified archived bytes before constructing a runtime', async () => {
    const captured = await capture({ modelId: MODEL_ID, revision: REVISION, bodies: toyBodies });
    const evidence = await createPartialModelSupportEvidence(evidenceItem({ capture: captured }));
    const zip = await JSZip.loadAsync(await evidence.blob.arrayBuffer());
    zip.file('replay-metadata/files/tokenizer.json', '{}');
    await expect(restore({ zip, prefix: '' })).rejects.toThrow('Replay integrity mismatch');
    zip.remove('replay-metadata/files/tokenizer.json');
    await expect(restore({ zip, prefix: '' })).rejects.toThrow('Missing archived file');
  });

  it.each(corpus)('exposes the missing tokenizer body in historical $modelId data instead of synthesizing success', async fixture => {
    const bodies = Object.fromEntries(fixture.declarations.map(file => [file.path, JSON.stringify(file.value)]));
    // Old Evidence contains parsed values only. Reserialization is explicitly a
    // test adapter, not a claim that original repository bytes were preserved.
    const captured = await capture({ modelId: fixture.modelId, revision: fixture.revision, bodies });
    const evidence = await createPartialModelSupportEvidence(evidenceItem({ capture: captured }));
    const archive = await restore({ zip: await JSZip.loadAsync(await evidence.blob.arrayBuffer()), prefix: '' });
    expect(archive.files.has('tokenizer.json')).toBe(false);
    const h = await runtimeFromArchive({ archive });
    await expect(h.runtime.AutoTokenizer.from_pretrained(fixture.modelId, { revision: fixture.revision, local_files_only: true })).rejects.toThrow(/tokenizer\.json/u);
    expect(h.observations).toEqual(expect.arrayContaining([expect.objectContaining({ result: 'miss', requestedPath: `huggingface.co/${fixture.modelId}/resolve/${fixture.revision}/tokenizer.json` })]));
    expect(h.mutations).not.toHaveBeenCalled();
    // Upstream attempts a same-origin /models fallback after the OPFS miss.
    // The actual Load Worker policy must reject it before transport; zero
    // upstream fetch attempts would be an inaccurate expectation for TJS 4.2.
    expect(h.guardedFetch.mock.calls.map(([input]) => input)).toEqual([`/models/${fixture.modelId}/tokenizer.json`]);
    expect(h.forbiddenFetch).not.toHaveBeenCalled();
  });

  it.each(corpus.filter(fixture => selectTransformersJsProductionRuntimeArtifactLoader({
    modelId: fixture.modelId,
    modelType: z.string().parse(fixture.declarations.find(file => file.path === 'config.json')!.value.model_type),
  }) !== 'tokenizer'))('reaches missing tokenizer bytes through the actual Production processor selection for $modelId', async fixture => {
    const captured = await capture({
      modelId: fixture.modelId, revision: fixture.revision,
      bodies: Object.fromEntries(fixture.declarations.map(file => [file.path, JSON.stringify(file.value)])),
    });
    const evidence = await createPartialModelSupportEvidence(evidenceItem({ capture: captured }));
    const archive = await restore({ zip: await JSZip.loadAsync(await evidence.blob.arrayBuffer()), prefix: '' });
    const h = await runtimeFromArchive({ archive });
    await expect(h.runtime.AutoProcessor.from_pretrained(fixture.modelId, { revision: fixture.revision, local_files_only: true })).rejects.toThrow(/tokenizer\.json/u);
    expect(h.observations).toEqual(expect.arrayContaining([expect.objectContaining({
      result: 'miss', requestedPath: `huggingface.co/${fixture.modelId}/resolve/${fixture.revision}/tokenizer.json`,
    })]));
    expect(h.reads).toContain(`models/huggingface.co/${fixture.modelId}/resolve/${fixture.revision}/preprocessor_config.json`);
    expect(h.mutations).not.toHaveBeenCalled();
    expect(h.forbiddenFetch).not.toHaveBeenCalled();
    // This first missing input does not enumerate later processor dependencies.
  });
});
