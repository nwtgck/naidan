import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { toVolumeId } from '@/01-models/ids';
import { createWorkflowTestFileSystem } from '@/00-storage/service/workflow-files.test-support';
import { stepId, baseStep } from './workflow.test-support';
import { createOutputStoreFixture } from './output-store.test-support';
import { readText, releaseValues, type RuntimeValue } from './values';
import { createWorkflowFileServices, exportWorkflowResults, workflowFileChunks, zipWorkflowFolder, clearWorkflowStagingDirectory, TEST_ONLY, type WorkflowWrittenFile } from './files';
import type { WorkflowRunResult } from './runtime';

const resolveVolumeAccess = vi.hoisted(() => vi.fn());
vi.mock('@/00-storage/service', () => ({ storageService: { resolveVolumeAccess } }));

afterEach(() => {
  vi.unstubAllGlobals();
  resolveVolumeAccess.mockReset();
});

const signal = (): AbortSignal => new AbortController().signal;

const jsonText = ({ text }: { text: string }): RuntimeValue => ({ type: 'json', value: text });

const emptyResult = (): WorkflowRunResult => ({ status: 'completed', error: undefined, outputs: new Map(), release: async () => undefined });

async function collect({ chunks }: { chunks: AsyncIterable<Uint8Array> }): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of chunks) {
    expect(chunk.byteLength).toBeLessThanOrEqual(32768);
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

describe('Workflow file output', () => {
  it('encodes split surrogate pairs without corrupting text and uses bounded chunks', async () => {
    const text = 'a'.repeat(8191) + '🌱日本語'.repeat(15000);
    expect(await collect({ chunks: workflowFileChunks({ source: jsonText({ text }), format: 'text', signal: signal() }) })).toBe(text);
  });

  it('serializes JSON Lines records separately, including escaped newlines', async () => {
    const source: RuntimeValue = {
      type: 'json',
      value: [{
        text: `\
a
b`,
      }, { text: '日本語' }],
    };
    const text = await collect({ chunks: workflowFileChunks({ source, format: 'jsonl', signal: signal() }) });
    expect(text.split('\n').filter(Boolean).map(line => JSON.parse(line))).toEqual([{
      text: `\
a
b`,
    }, { text: '日本語' }]);
  });

  it('rejects binary output for text instead of guessing an encoding', async () => {
    await expect(collect({ chunks: workflowFileChunks({ source: jsonText({ text: 'abc' }), format: 'binary', signal: signal() }) })).rejects.toThrow('binary value');
  });

  it('publishes on close, rejects existing files, and never overwrites on error policy', async () => {
    using fs = createWorkflowTestFileSystem();
    const options = { directory: fs.root, path: ['result.txt'], source: jsonText({ text: 'first' }), format: 'text' as const, onConflict: 'error' as const, signal: signal(), maxBytes: 100 };
    expect(await TEST_ONLY.saveFile(options)).toBe(5);
    await expect(TEST_ONLY.saveFile({ ...options, source: jsonText({ text: 'second' }) })).rejects.toThrow('already exists');
    expect(fs.text({ path: 'result.txt' })).toBe('first');
  });

  it('preserves an existing file on quota failure and close failure', async () => {
    using fs = createWorkflowTestFileSystem();
    fs.setText({ path: 'result.txt', text: 'old' });
    const options = { directory: fs.root, path: ['result.txt'], source: jsonText({ text: 'new' }), format: 'text' as const, onConflict: 'overwrite' as const, signal: signal(), maxBytes: 2 };
    await expect(TEST_ONLY.saveFile(options)).rejects.toThrow('budget');
    expect(fs.text({ path: 'result.txt' })).toBe('old');
    fs.failClose({ error: new Error('storage failed') });
    await expect(TEST_ONLY.saveFile({ ...options, maxBytes: 10 })).rejects.toThrow('storage failed');
    expect(fs.text({ path: 'result.txt' })).toBe('old');
  });

  it('rejects traversal before creating directories or files', async () => {
    using fs = createWorkflowTestFileSystem();
    await expect(TEST_ONLY.saveFile({ directory: fs.root, path: ['..', 'secret'], source: jsonText({ text: 'x' }), format: 'text', onConflict: 'error', signal: signal(), maxBytes: 100 })).rejects.toThrow();
    expect(fs.files.size).toBe(0);
  });

  it('does not open a Volume after access is denied', async () => {
    const files = createWorkflowFileServices({
      authorize: async () => {
        throw new Error('denied');
      },
      onWritten: () => undefined,
    });
    const step = baseStep({ type: 'write_file', id: 'write' });
    if (step.type !== 'write_file') {
      throw new Error('fixture');
    }
    await expect(files.writeFile({ step, source: jsonText({ text: 'x' }), path: ['x.txt'], signal: signal() })).rejects.toThrow('denied');
    expect(resolveVolumeAccess).not.toHaveBeenCalled();
  });

  it('records a user-file location only after a successful write', async () => {
    using fs = createWorkflowTestFileSystem();
    resolveVolumeAccess.mockResolvedValue({ kind: 'native', handle: fs.root });
    vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, callback: () => Promise<unknown>) => callback() } });
    const written: WorkflowWrittenFile[] = [];
    const files = createWorkflowFileServices({
      authorize: async () => undefined,
      onWritten: ({ file }) => {
        written.push(file);
      },
    });
    const step = baseStep({ type: 'write_file', id: 'write' });
    if (step.type !== 'write_file') {
      throw new Error('fixture');
    }
    step.volumeId = toVolumeId({ raw: 'volume' });
    await files.writeFile({ step, path: ['sub', 'a.txt'], source: jsonText({ text: 'hello' }), signal: signal() });
    expect(written).toEqual([{ volumeId: step.volumeId, relativePath: 'sub/a.txt', size: 5 }]);
    fs.failClose({ error: new Error('disk full') });
    await expect(files.writeFile({ step, path: ['sub', 'b.txt'], source: jsonText({ text: 'lost' }), signal: signal() })).rejects.toThrow('disk full');
    expect(written).toHaveLength(1);
  });

  it('reads a file once into independently readable text and binary outputs', async () => {
    using fs = createWorkflowTestFileSystem();
    fs.setText({ path: 'a.txt', text: 'hello 日本語' });
    resolveVolumeAccess.mockResolvedValue({ kind: 'native', handle: fs.root });
    await using fixture = createOutputStoreFixture({ limits: {} });
    const files = createWorkflowFileServices({ authorize: async () => undefined, onWritten: () => undefined });
    const outputs = await files.readFile({ volumeId: toVolumeId({ raw: 'v' }), path: ['a.txt'], signal: signal(), store: fixture.store });
    await using cleanup = {
      async [Symbol.asyncDispose]() {
        await releaseValues({ values: Object.values(outputs) });
      },
    };
    void cleanup;
    fs.setText({ path: 'a.txt', text: 'changed afterwards' });
    expect(await readText({ value: outputs.text!, signal: signal(), maxBytes: 100 })).toBe('hello 日本語');
    expect(outputs.content?.type).toBe('binary');
  });

  it('exports only explicitly saved files, never siblings in a selected Volume', async () => {
    using source = createWorkflowTestFileSystem();
    using destination = createWorkflowTestFileSystem();
    source.setText({ path: 'answer.txt', text: 'answer' });
    source.setText({ path: 'private.txt', text: 'secret' });
    resolveVolumeAccess.mockResolvedValue({ kind: 'native', handle: source.root });
    await exportWorkflowResults({ result: emptyResult(), directory: destination.root, signal: signal(), writtenFiles: [{ volumeId: toVolumeId({ raw: 'v' }), relativePath: 'answer.txt', size: 6 }] });
    expect(destination.text({ path: 'files/folder-1/answer.txt' })).toBe('answer');
    expect([...destination.files.keys()].some(key => key.includes('private'))).toBe(false);
  });

  it('omits nested model capabilities from exports but preserves ordinary literal JSON', async () => {
    using fs = createWorkflowTestFileSystem();
    const model: RuntimeValue = { type: 'model', endpoint: { type: 'openai', url: 'https://example.invalid/v1', httpHeaders: [['Authorization', 'SECRET']] }, modelId: 'model' };
    const result = emptyResult();
    const outputs = new Map([[stepId({ raw: '../unsafe' }), { connection: { type: 'object' as const, properties: { nested: model } }, data: { type: 'json' as const, value: { type: 'model', label: 'literal' } } }]]);
    await exportWorkflowResults({ result: { ...result, outputs }, directory: fs.root, signal: signal(), writtenFiles: [] });
    expect([...fs.files.values()].map(bytes => new TextDecoder().decode(bytes)).join('\n')).not.toContain('SECRET');
    expect(fs.text({ path: 'result-0002.json' })).toContain('literal');
    expect(fs.text({ path: 'index.json' })).toContain('Contains a model connection');
  });

  it('reuses the real streaming ZIP writer and clears only its staging directory', async () => {
    using source = createWorkflowTestFileSystem();
    using zipped = createWorkflowTestFileSystem();
    source.setText({ path: 'answer.txt', text: 'hello 日本語' });
    const file = await zipWorkflowFolder({ directory: source.root, zipDirectory: zipped.root, signal: signal() });
    const zip = await JSZip.loadAsync(new Uint8Array(await file.arrayBuffer()));
    expect(await zip.file('workflow-results/answer.txt')?.async('string')).toBe('hello 日本語');
    await clearWorkflowStagingDirectory({ directory: zipped.root });
    expect(zipped.files.size).toBe(0);
    expect(source.text({ path: 'answer.txt' })).toBe('hello 日本語');
  });
});
