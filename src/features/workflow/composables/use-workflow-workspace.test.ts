import { File as NodeFile, Blob as NodeBlob } from 'node:buffer';
import { ref } from 'vue';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { createRouter, createMemoryHistory } from 'vue-router';
import WorkflowWorkspaceView from '@/features/workflow/WorkflowWorkspace.vue';
import { formatWorkflowDefinition } from '@/00-storage/service/workflow-json';
import { createWorkflowRunStore } from '@/00-storage/service/workflow-run';
import * as runStoreModule from '@/00-storage/service/workflow-run';
import { OPFS_TMP_DIR } from '@/constants';
import WorkflowView from '@/features/workflow/WorkflowView.vue';
import WorkflowGraph from '@/features/workflow/components/WorkflowGraph.vue';
import SettingsSelect from '@/components/SettingsSelect.vue';
import * as workspaceModule from './use-workflow-workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { createWorkflowTestFileSystem } from '@/00-storage/service/workflow-files.test-support';
import { createWorkflowTestLocks } from '@/00-storage/service/workflow-locks.test-support';
import { TEST_ONLY, type WorkflowWorkspace } from './use-workflow-workspace';
import { stepId, baseStep } from '@/features/workflow/logic/workflow.test-support';
import type { LmProvider } from '@/01-models/lm';
import { idToRaw, toWorkflowId, toVolumeId, toToolCallId } from '@/01-models/ids';
import { DEFAULT_WORKFLOW_EXECUTION_LIMITS } from '@/features/workflow/logic/execution-control';
import { audioStep, audioResult } from '@/features/workflow/logic/audio-generation.test-support';
import { literal, reference } from '@/features/workflow/logic/workflow.test-support';
import { imageStep, imageSelection, imageResult } from '@/features/workflow/logic/image-generation.test-support';
import { toolStep, toolRequest } from '@/features/workflow/logic/tool.test-support';
import type { WorkflowToolExecution } from '@/features/workflow/logic/tool-execution';
import type { WorkflowDefinition } from '@/01-models/workflow';

const mocks = vi.hoisted(() => ({ confirm: vi.fn(), prompt: vi.fn(), save: vi.fn(), list: vi.fn(), load: vi.fn(), remove: vi.fn(), createTmpDirectory: vi.fn(), downloadFile: vi.fn(), downloadBlob: vi.fn(), openFileExplorer: vi.fn(), loadLmProvider: vi.fn(), generateAudio: vi.fn(), resolveVolumeAccess: vi.fn(), normalizeReference: vi.fn(), generateImage: vi.fn(), createImageProvider: vi.fn(), closeImage: vi.fn(), executeTool: vi.fn() }));
const settings = ref({ storageType: 'opfs', endpoint: { type: 'ollama', url: 'http://localhost:11434' }, defaultModelId: 'test', lmParameters: {}, experimental: undefined });
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings }) }));
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: mocks.confirm }) }));
vi.mock('@/composables/usePrompt', () => ({ usePrompt: () => ({ showPrompt: mocks.prompt }) }));
vi.mock('@/00-storage/service/workflow-document', () => ({ createWorkflowDocumentStore: () => ({ save: mocks.save, load: mocks.load, remove: mocks.remove, list: mocks.list }) }));
vi.mock('@/00-storage/service', () => ({ storageService: { getCurrentType: () => settings.value.storageType, resolveVolumeAccess: mocks.resolveVolumeAccess, async *listVolumes() {} } }));
vi.mock('@/features/llama-cpp-browser', () => ({ llamaCppBrowserService: { generateAudio: mocks.generateAudio } }));
vi.mock('@/features/audio-generation/reference-audio', () => ({ normalizeReferenceAudio: mocks.normalizeReference }));
vi.mock('@/features/lm/providerFactory', () => ({ loadLmProvider: mocks.loadLmProvider }));
vi.mock('@/logic/opfs-tmp-manager', () => ({ getOPFSTmpManager: () => ({ createTmpDirectory: mocks.createTmpDirectory }) }));
vi.mock('@/features/file-explorer/composables/useFileExplorerModal', () => ({ useFileExplorerModal: () => ({ openFileExplorer: mocks.openFileExplorer }) }));
vi.mock('@/utils/stream-download', () => ({ downloadFile: mocks.downloadFile, downloadBlob: mocks.downloadBlob }));

vi.mock('@/features/workflow/providers/tools', () => ({ executeWorkflowBuiltinTool: mocks.executeTool }));

vi.mock('@/features/workflow/providers/local-image', () => ({ createWorkflowImageProvider: mocks.createImageProvider }));

const workspaces: WorkflowWorkspace[] = [];
const wrappers: VueWrapper[] = [];
const containers: HTMLDivElement[] = [];

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  vi.stubGlobal('File', NodeFile);
  vi.stubGlobal('navigator', { locks: {} });
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.confirm.mockResolvedValue(false);
  mocks.list.mockResolvedValue({ items: [], unreadable: [] });
  settings.value.storageType = 'opfs';
});

afterEach(async () => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount());
  containers.splice(0).forEach(container => container.remove());
  vi.restoreAllMocks();
  for (const workspace of workspaces.splice(0)) {
    await workspace.TEST_ONLY?.close();
  }
  vi.unstubAllGlobals();
});

function workspace(): WorkflowWorkspace {
  const value = TEST_ONLY.createWorkspace();
  workspaces.push(value);
  return value;
}

async function adopt({ workspace, definition }: { workspace: WorkflowWorkspace, definition: WorkflowDefinition }): Promise<void> {
  await workspace.changeMode({ next: 'json' });
  workspace.jsonDraft.value = formatWorkflowDefinition({ definition });
  workspace.applyJson();
  expect(workspace.error.value).toBe('');
  await workspace.changeMode({ next: 'steps' });
}

const valueStep = ({ id, value }: { id: string, value: string }) => ({ type: 'value' as const, id: stepId({ raw: id }), name: id, value: { type: 'literal' as const, value } });

describe('Workflow workspace', () => {
  it('starts clean and exposes only the editable definition in JSON', async () => {
    const state = workspace();
    expect(state.dirty.value).toBe(false);
    await state.changeMode({ next: 'json' });
    expect(JSON.parse(state.jsonDraft.value)).toEqual({ name: '', steps: [] });
    state.jsonDraft.value = '{"name":"draft","steps":[],"createdAt":42}';
    state.applyJson();
    expect(state.error.value).not.toBe('');
    expect(state.definition.value.name).toBe('');
  });

  it('preserves invalid JSON on failed apply and declined view changes', async () => {
    const state = workspace();
    await state.changeMode({ next: 'json' });
    state.jsonDraft.value = '{';
    state.applyJson();
    expect(state.error.value).not.toBe('');
    await state.changeMode({ next: 'graph' });
    expect(state.mode.value).toBe('json');
    expect(state.jsonDraft.value).toBe('{');
    mocks.confirm.mockResolvedValue(true);
    await state.changeMode({ next: 'steps' });
    expect(state.mode.value).toBe('steps');
    expect(state.draftDirty.value).toBe(false);
  });

  it('does not apply an old discard answer to newer JSON input', async () => {
    const state = workspace();
    await state.changeMode({ next: 'json' });
    state.jsonDraft.value = '{';
    const gate = Promise.withResolvers<boolean>();
    mocks.confirm.mockReturnValue(gate.promise);
    const change = state.changeMode({ next: 'steps' });
    await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    state.jsonDraft.value = '{"name"';
    gate.resolve(true);
    await change;
    expect(state.mode.value).toBe('json');
    expect(state.jsonDraft.value).toBe('{"name"');
  });

  it('applies a step partial without changing its identity and supports undo', async () => {
    const state = workspace();
    await adopt({ workspace: state, definition: { name: 'test', steps: [valueStep({ id: 'a', value: 'old' })] } });
    state.select({ id: stepId({ raw: 'a' }), multiple: false });
    state.openPartial();
    state.partialDraft.value = '{"value":{"value":"new"}}';
    state.applyPartial();
    expect(state.selected.value).toMatchObject({ id: 'a', value: { type: 'literal', value: 'new' } });
    state.travel({ direction: 'undo' });
    expect(state.selected.value).toMatchObject({ value: { value: 'old' } });
    state.openPartial();
    state.partialDraft.value = '{"id":"renamed"}';
    state.applyPartial();
    expect(state.error.value).not.toBe('');
    expect(state.partialOpen.value).toBe(true);
  });

  it('protects an inline draft from selection, structural movement and route exit', async () => {
    const state = workspace();
    await adopt({ workspace: state, definition: { name: 'test', steps: [valueStep({ id: 'a', value: 'A' }), valueStep({ id: 'b', value: 'B' })] } });
    state.select({ id: stepId({ raw: 'a' }), multiple: false });
    const discard = vi.fn();
    state.inlineDrafts.update({ owner: Symbol('field'), text: '{', discard });
    state.select({ id: stepId({ raw: 'b' }), multiple: false });
    state.move({ id: stepId({ raw: 'a' }), target: { parentId: undefined, branch: 'root', index: 2 } });
    expect(state.selectedId.value).toBe('a');
    expect(state.definition.value.steps.map(step => step.id)).toEqual(['a', 'b']);
    expect(await state.confirmInlineExit()).toBe(false);
    expect(discard).not.toHaveBeenCalled();
    mocks.confirm.mockResolvedValue(true);
    expect(await state.confirmInlineExit()).toBe(true);
    expect(discard).toHaveBeenCalledOnce();
  });

  it('stores managed metadata outside the editing surface and reports save conflicts without losing drafts', async () => {
    const state = workspace();
    state.updateName({ name: 'Saved' });
    mocks.save.mockResolvedValue({ document: { id: toWorkflowId({ raw: 'doc' }), kind: 'workflow', createdAt: 1, updatedAt: 2, definition: { name: 'Saved', steps: [] } }, source: 'snapshot' });
    await state.save({ copy: false });
    expect(state.dirty.value).toBe(false);
    state.updateName({ name: 'Changed' });
    mocks.save.mockRejectedValue(new Error('Changed in another editor'));
    await state.save({ copy: false });
    expect(state.definition.value.name).toBe('Changed');
    expect(state.dirty.value).toBe(true);
    expect(state.error.value).toContain('another editor');
    await state.changeMode({ next: 'json' });
    expect(JSON.parse(state.jsonDraft.value)).toEqual({ name: 'Changed', steps: [] });
  });

  it('does not execute disabled tool configurations or unresolved references', async () => {
    const state = workspace();
    await adopt({ workspace: state, definition: { name: 'broken', steps: [{ ...valueStep({ id: 'a', value: '' }), value: { type: 'step_output', stepId: stepId({ raw: 'missing' }), output: 'text' } }] } });
    expect(state.issues.value.length).toBeGreaterThan(0);
    await state.start();
    expect(state.runState.value).toBe('idle');
    expect(mocks.createTmpDirectory).not.toHaveBeenCalled();
  });

  it('waits for interactive input, rejects a stale reply, and keeps the run snapshot while editing', async () => {
    using fs = createWorkflowTestFileSystem();
    let index = 0;
    mocks.createTmpDirectory.mockImplementation(async () => fs.root.getDirectoryHandle(`tmp-${++index}`, { create: true }));
    const state = workspace();
    await adopt({ workspace: state, definition: { name: 'input', steps: [valueStep({ id: 'before', value: 'saved first' }), { id: stepId({ raw: 'ask' }), name: 'Enter data', type: 'request_input', responseType: 'text', prompt: { type: 'literal', value: 'Your input' } }] } });
    const run = state.start();
    await vi.waitFor(() => expect(state.pending.value?.kind).toBe('text'));
    const token = state.pending.value!.token;
    state.respond({ token: token - 1, text: 'stale' });
    expect(state.pending.value?.token).toBe(token);
    state.updateName({ name: 'edited during run' });
    state.respond({ token, text: 'reply' });
    await run;
    expect(state.runState.value).toBe('completed');
    expect(state.log.value.at(-1)?.preview).toContain('reply');
    expect(state.definition.value.name).toBe('edited during run');
    await state.openResults({ zip: true });
    await state.openResults({ zip: true });
    expect(state.error.value).toBe('');
    expect(mocks.downloadFile).toHaveBeenCalledTimes(2);
    expect(mocks.createTmpDirectory).toHaveBeenCalledTimes(3);
    await state.clearResults({ confirm: false });
    expect(state.hasResults.value).toBe(false);
    expect(fs.files.size).toBe(0);
  });

  it('retains completed output after cancellation while waiting for input', async () => {
    using fs = createWorkflowTestFileSystem();
    mocks.createTmpDirectory.mockResolvedValue(fs.root);
    const state = workspace();
    await adopt({ workspace: state, definition: { name: 'input', steps: [valueStep({ id: 'before', value: 'saved first' }), { id: stepId({ raw: 'ask' }), name: 'Input', type: 'request_input', responseType: 'text', prompt: { type: 'literal', value: '?' } }] } });
    const run = state.start();
    await vi.waitFor(() => expect(state.pending.value).toBeDefined());
    state.stop();
    await run;
    expect(state.runState.value).toBe('cancelled');
    expect(state.hasResults.value).toBe(true);
    expect(state.log.value[0]?.preview).toContain('saved first');
    expect(state.pending.value).toBeUndefined();
  });

  it('requires explicit connection approval before creating a model provider', async () => {
    using fs = createWorkflowTestFileSystem();
    mocks.createTmpDirectory.mockResolvedValue(fs.root);
    const state = workspace();
    await state.sample();
    const run = state.start();
    await vi.waitFor(() => expect(state.pending.value?.kind).toBe('approval'));
    expect(mocks.loadLmProvider).not.toHaveBeenCalled();
    state.respond({ token: state.pending.value!.token, text: 'deny' });
    await run;
    expect(state.runState.value).toBe('failed');
    expect(mocks.loadLmProvider).not.toHaveBeenCalled();
  });

  it('renders an early generation chunk even when the next chunk is delayed', async () => {
    using fs = createWorkflowTestFileSystem();
    mocks.createTmpDirectory.mockResolvedValue(fs.root);
    const gate = Promise.withResolvers<void>();
    const provider: LmProvider = {
      listModels: async () => [],
      async *chat() {
        yield {
          type: 'text',
          partId: 'answer',
          index: 0,
          completeness: Promise.resolve('complete'),
          chunks: (async function* () {
            yield 'streamed before completion';
            await gate.promise;
            yield ' and finished';
          })(),
        };
        yield { type: 'result', result: { type: 'finished', next: 'user' } };
      },
    };
    mocks.loadLmProvider.mockResolvedValue(provider);
    const step = baseStep({ type: 'text_generation', id: 'stream' });
    if (step.type !== 'text_generation') {
      throw new Error('fixture');
    }
    step.appendMessages = [{ role: 'user', parts: [{ type: 'text', text: 'actual request' }] }];
    const state = workspace();
    await adopt({ workspace: state, definition: { name: 'Streaming', steps: [step] } });
    vi.spyOn(workspaceModule, 'useWorkflowWorkspace').mockReturnValue(state);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workflows', component: WorkflowView }] });
    await router.push('/workflows');
    await router.isReady();
    const wrapper = mount({ template: '<router-view />' }, { global: { plugins: [router] } });
    wrappers.push(wrapper);
    await flushPromises();
    const run = state.start();
    await using pending = {
      run,
      async [Symbol.asyncDispose]() {
        gate.resolve();
        await run;
      },
    };
    await vi.waitFor(() => expect(state.pending.value?.kind).toBe('approval'));
    state.respond({ token: state.pending.value!.token, text: 'allow' });
    await vi.waitFor(() => expect(wrapper.find('[data-testid="workflow-live-output"]').text()).toContain('streamed before completion'));
    expect(state.runState.value).toBe('running');
    expect(state.log.value[0]?.inputPreview).toContain('actual request');
    gate.resolve();
    await pending.run;
    expect(state.runState.value).toBe('completed');
  });

  it('renders the real editor and executes its run button, with route protection for inline drafts', async () => {
    using fs = createWorkflowTestFileSystem();
    let index = 0;
    mocks.createTmpDirectory.mockImplementation(async () => fs.root.getDirectoryHandle(`tmp-${++index}`, { create: true }));
    const state = workspace();
    await adopt({ workspace: state, definition: { name: 'UI workflow', steps: [valueStep({ id: 'a', value: 'hello' })] } });
    vi.spyOn(workspaceModule, 'useWorkflowWorkspace').mockReturnValue(state);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workflows', component: WorkflowView }, { path: '/chat', component: { template: '<div>chat</div>' } }] });
    await router.push('/workflows');
    await router.isReady();
    const wrapper = mount({ template: '<router-view />' }, { global: { plugins: [router] } });
    wrappers.push(wrapper);
    await flushPromises();
    expect(wrapper.find('[data-testid="workflow-view"]').exists()).toBe(true);
    expect((wrapper.get('input[aria-label="Workflow or part name"]').element as HTMLInputElement).value).toBe('UI workflow');
    await wrapper.get('[data-testid="workflow-run"]').trigger('click');
    await vi.waitFor(() => expect(state.runState.value).toBe('completed'));
    expect(wrapper.text()).toContain('hello');
    state.inlineDrafts.update({ owner: Symbol('unapplied'), text: '{', discard: () => undefined });
    await router.push('/chat');
    expect(router.currentRoute.value.path).toBe('/workflows');
    mocks.confirm.mockResolvedValue(true);
    await router.push('/chat');
    expect(router.currentRoute.value.path).toBe('/chat');
  });
});

function historyFileSystem({ files }: { files: ReturnType<typeof createWorkflowTestFileSystem> }) {
  const manager = createWorkflowTestLocks();
  vi.stubGlobal('navigator', {
    locks: manager.locks,
    storage: { getDirectory: async () => files.root },
  });
  let serial = 0;
  mocks.createTmpDirectory.mockImplementation(async ({ prefix }: { prefix: string }) => {
    const root = await files.root.getDirectoryHandle(OPFS_TMP_DIR, { create: true });
    const owner = await root.getDirectoryHandle('owner', { create: true });
    return owner.getDirectoryHandle(`${prefix}-${++serial}`, { create: true });
  });
  return manager;
}

async function routedWorkspace({ state, path }: { state: WorkflowWorkspace, path: string }) {
  vi.spyOn(workspaceModule, 'useWorkflowWorkspace').mockReturnValue(state);
  const leaf = { template: '<span />' };
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/workflows',
        component: WorkflowWorkspaceView,
        children: [
          { path: ':workflowId', component: leaf }, { path: 'runs', component: leaf }, { path: 'runs/:runId', component: leaf },
        ],
      },
      { path: '/chat', component: { template: '<div>chat</div>' } },
    ],
  });
  await router.push(path);
  await router.isReady();
  // Attach the route host: detached jsdom nodes can retain a stale computed
  // display value after v-show is removed, unlike a connected browser tree.
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const wrapper = mount({ template: '<router-view />' }, { attachTo: container, global: { plugins: [router] } });
  wrappers.push(wrapper);
  await flushPromises();
  return { router, wrapper };
}

describe('Workflow durable history and routing', () => {
  it('persists a run snapshot and retains its result files when another run starts', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    const state = workspace();
    await adopt({ workspace: state, definition: { name: 'First', steps: [valueStep({ id: 'a', value: 'first result' })] } });
    await state.start();
    expect(state.runState.value).toBe('completed');
    expect(state.historyError.value).toBe('');
    const runs = createWorkflowRunStore({ storageType: 'opfs' });
    const firstId = state.activeRunId.value!;
    const first = await runs.load({ id: firstId });
    expect(first.record.status).toBe('completed');
    expect(first.record.definition.name).toBe('First');
    expect(first.record.entries[0]?.preview).toContain('first result');
    expect(first.record.resultsPath).toBeDefined();
    const firstFiles = [...files.files.keys()].filter(path => path.startsWith(first.record.resultsPath!.join('/')));
    expect(firstFiles.length).toBeGreaterThan(0);
    state.updateName({ name: 'Second' });
    await state.start();
    expect(state.runState.value).toBe('completed');
    expect(state.activeRunId.value).not.toBe(firstId);
    expect((await runs.list()).items).toHaveLength(2);
    expect((await runs.load({ id: firstId })).record.definition.name).toBe('First');
    expect(firstFiles.every(path => files.files.has(path))).toBe(true);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it('persists effective execution limits and copies them without reusing history identity', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    const state = workspace();
    await adopt({ workspace: state, definition: { name: 'Budget', steps: [valueStep({ id: 'a', value: 'keep' })] } });
    await state.start();
    const stored = await createWorkflowRunStore({ storageType: 'opfs' }).load({ id: state.activeRunId.value! });
    expect(stored.record.definition.executionLimits).toEqual(DEFAULT_WORKFLOW_EXECUTION_LIMITS);
    expect(state.definition.value.executionLimits).toBeUndefined();
    mocks.confirm.mockResolvedValue(true);
    expect(await state.copyRun({ snapshot: stored, canApply: () => true })).toBe(true);
    expect(state.definition.value.executionLimits).toEqual(DEFAULT_WORKFLOW_EXECUTION_LIMITS);
    expect(state.definition.value.steps[0]?.id).not.toBe(stored.record.definition.steps[0]?.id);
    expect(state.saved.value).toBeUndefined();
    state.updateExecutionLimits({ limits: undefined });
    expect(state.definition.value.executionLimits).toBeUndefined();
    state.travel({ direction: 'undo' });
    expect(state.definition.value.executionLimits).toEqual(DEFAULT_WORKFLOW_EXECUTION_LIMITS);
  });

  it('does not apply limits edited during an input wait to the running execution', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    const state = workspace();
    await adopt({
      workspace: state,
      definition: {
        name: 'Snapshot',
        steps: [
          { id: stepId({ raw: 'ask' }), name: 'Input', type: 'request_input', responseType: 'text', prompt: { type: 'literal', value: '?' } },
          valueStep({ id: 'after', value: 'still executes' }),
        ],
        executionLimits: { ...DEFAULT_WORKFLOW_EXECUTION_LIMITS, maxStepExecutions: 2 },
      },
    });
    const pending = state.start();
    await using run = {
      async [Symbol.asyncDispose]() {
        state.stop();
        await pending;
      },
    };
    void run;
    await vi.waitFor(() => expect(state.pending.value).toBeDefined());
    state.updateExecutionLimits({ limits: { ...DEFAULT_WORKFLOW_EXECUTION_LIMITS, maxStepExecutions: 0 } });
    expect(state.definition.value.executionLimits?.maxStepExecutions).toBe(0);
    state.respond({ token: state.pending.value!.token, text: 'continue' });
    await pending;
    expect(state.runState.value).toBe('completed');
    const stored = await createWorkflowRunStore({ storageType: 'opfs' }).load({ id: state.activeRunId.value! });
    expect(stored.record.definition.executionLimits?.maxStepExecutions).toBe(2);
    await state.start();
    expect(state.runState.value).toBe('failed');
    expect(state.pending.value).toBeUndefined();
  });

  it('records a cancelled run and preserves completed step previews', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    const state = workspace();
    await adopt({
      workspace: state,
      definition: {
        name: 'Cancelled',
        steps: [
          valueStep({ id: 'before', value: 'keep' }),
          { id: stepId({ raw: 'ask' }), name: 'Input', type: 'request_input', responseType: 'text', prompt: { type: 'literal', value: '?' } },
        ],
      },
    });
    const pending = state.start();
    await vi.waitFor(() => expect(state.pending.value).toBeDefined());
    state.stop();
    await pending;
    const stored = await createWorkflowRunStore({ storageType: 'opfs' }).load({ id: state.activeRunId.value! });
    expect(stored.record.status).toBe('cancelled');
    expect(stored.record.entries[0]?.preview).toContain('keep');
    expect(stored.record.definition.steps).toHaveLength(2);
  });

  it('does not execute when persisting the initial snapshot fails', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    files.failClose({ error: new Error('cannot save start') });
    const state = workspace();
    await adopt({ workspace: state, definition: { name: 'Cannot run', steps: [valueStep({ id: 'x', value: 'never' })] } });
    await state.start();
    expect(state.error.value).toContain('cannot save start');
    expect(state.log.value).toEqual([]);
    expect(mocks.createTmpDirectory).not.toHaveBeenCalled();
    expect(mocks.loadLmProvider).not.toHaveBeenCalled();
  });

  it('copies a historical snapshot with rewritten references, without restoring execution permissions', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    const state = workspace();
    const runs = createWorkflowRunStore({ storageType: 'opfs' });
    const snapshot = await runs.create({
      workflowId: toWorkflowId({ raw: 'removed' }),
      definition: {
        name: 'Snapshot',
        steps: [
          valueStep({ id: 'a', value: 'first' }),
          { ...valueStep({ id: 'b', value: '' }), value: { type: 'step_output', stepId: stepId({ raw: 'a' }), output: 'value' } },
        ],
      },
    });
    await runs.release({ id: snapshot.record.id });
    expect(await state.copyRun({ snapshot, canApply: () => true })).toBe(true);
    expect(state.saved.value).toBeUndefined();
    expect(state.dirty.value).toBe(true);
    expect(state.definition.value.steps[0]?.id).not.toBe('a');
    expect(state.definition.value.steps[1]).toMatchObject({ value: { stepId: state.definition.value.steps[0]?.id } });
    expect(snapshot.record.definition.steps[0]?.id).toBe('a');
    expect(state.runState.value).toBe('idle');
    expect(mocks.loadLmProvider).not.toHaveBeenCalled();
  });

  it('loads explicit document routes and prevents a slow load from replacing a newer route', async () => {
    const state = workspace();
    const gate = Promise.withResolvers<unknown>();
    const document = { id: toWorkflowId({ raw: 'newer' }), kind: 'workflow', createdAt: 1, updatedAt: 2, definition: { name: 'Newer', steps: [] } };
    mocks.load.mockImplementation(({ id }: { id: string }) => id === 'slow' ? gate.promise : Promise.resolve({ document, source: 'newer' }));
    const { router, wrapper } = await routedWorkspace({ state, path: '/workflows/slow' });
    expect(wrapper.text()).toContain('Loading');
    await router.push('/workflows/newer');
    await vi.waitFor(() => expect(state.saved.value?.document.id).toBe('newer'));
    gate.resolve({ document: { ...document, id: toWorkflowId({ raw: 'slow' }), definition: { name: 'Late', steps: [] } }, source: 'late' });
    await flushPromises();
    expect(state.definition.value.name).toBe('Newer');
    expect(router.currentRoute.value.path).toBe('/workflows/newer');
  });

  it('keeps drafts and URL when switching documents is declined', async () => {
    const state = workspace();
    const original = { document: { id: toWorkflowId({ raw: 'first' }), kind: 'workflow' as const, createdAt: 1, updatedAt: 2, definition: { name: 'First', steps: [] } }, source: 'first' };
    mocks.load.mockResolvedValue(original);
    const { router } = await routedWorkspace({ state, path: '/workflows/first' });
    await vi.waitFor(() => expect(state.saved.value?.document.id).toBe('first'));
    state.updateName({ name: 'Unsaved' });
    mocks.confirm.mockResolvedValue(false);
    await router.push('/workflows/second');
    expect(router.currentRoute.value.path).toBe('/workflows/first');
    expect(state.definition.value.name).toBe('Unsaved');
    expect(mocks.load).toHaveBeenCalledTimes(1);
  });

  it('shows a missing deep-link error instead of silently editing the previous document', async () => {
    const state = workspace();
    state.updateName({ name: 'Retained' });
    mocks.confirm.mockResolvedValue(true);
    mocks.load.mockRejectedValue(new Error('Workflow document was not found.'));
    const { router, wrapper } = await routedWorkspace({ state, path: '/workflows/missing' });
    await vi.waitFor(() => expect(wrapper.text()).toContain('not found'));
    expect(router.currentRoute.value.path).toBe('/workflows/missing');
    expect(state.definition.value.name).toBe('Retained');
    expect(wrapper.get('[data-testid="workflow-view"]').isVisible()).toBe(false);
  });

  it('keeps the editor mounted across history navigation and copies expired-result snapshots', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    const runs = createWorkflowRunStore({ storageType: 'opfs' });
    const initial = await runs.create({ workflowId: undefined, definition: { name: 'Historical', steps: [valueStep({ id: 'old', value: 'old data' })] } });
    const completed = await runs.finish({ previous: initial, status: 'completed', entries: [], error: undefined, resultsPath: [OPFS_TMP_DIR, 'expired', 'workflow-results-gone'], resultError: undefined });
    const state = workspace();
    const { router, wrapper } = await routedWorkspace({ state, path: '/workflows' });
    state.updateName({ name: 'Editing' });
    await router.push(`/workflows/runs/${idToRaw({ id: completed.record.id })}`);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="workflow-history-files"]').exists()).toBe(true));
    await wrapper.get('[data-testid="workflow-history-files"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.get('[data-testid="workflow-results-unavailable"]').text()).toContain('no longer available'));
    expect(state.definition.value.name).toBe('Editing');
    expect(wrapper.get('[data-testid="workflow-view"]').isVisible()).toBe(false);
    mocks.confirm.mockResolvedValue(true);
    await wrapper.get('[data-testid="workflow-copy-run"]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/workflows'));
    expect(state.definition.value.name).toBe('Historical');
    expect(state.saved.value).toBeUndefined();
    expect(mocks.loadLmProvider).not.toHaveBeenCalled();
  });
});

describe('Workflow history failure recovery', () => {
  it('retries a terminal save without rerunning steps and blocks a new run until resolved', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    const originalFactory = runStoreModule.createWorkflowRunStore;
    let shouldFail = true, finishes = 0;
    vi.spyOn(runStoreModule, 'createWorkflowRunStore').mockImplementation(args => {
      const store = originalFactory(args);
      return {
        ...store,
        async finish(input) {
          finishes++;
          if (shouldFail) {
            throw new Error('completion write failed');
          }
          return store.finish(input);
        },
      };
    });
    const state = workspace();
    await adopt({ workspace: state, definition: { name: 'Retry only history', steps: [valueStep({ id: 'a', value: 'once' })] } });
    await state.start();
    expect(state.runState.value).toBe('completed');
    expect(state.historySavePending.value).toBe(true);
    expect(state.historyError.value).toContain('completion write failed');
    const directoryCount = mocks.createTmpDirectory.mock.calls.length;
    const entries = [...state.log.value];
    const id = state.activeRunId.value!;
    const other = originalFactory({ storageType: 'opfs' });
    const durable = await other.load({ id });
    expect(await other.activity({ previous: durable })).toBe('active');
    await expect(other.interrupt({ previous: durable })).rejects.toThrow('active');
    expect(await state.clearResults({ confirm: false })).toBe(false);
    expect(state.log.value).toEqual(entries);
    await state.start();
    expect(mocks.createTmpDirectory).toHaveBeenCalledTimes(directoryCount);
    expect(state.activeRunId.value).toBe(id);
    shouldFail = false;
    await state.retryHistorySave();
    expect(finishes).toBe(2);
    expect(state.historySavePending.value).toBe(false);
    expect(state.historyError.value).toBe('');
    expect(state.log.value).toEqual(entries);
    expect(mocks.createTmpDirectory).toHaveBeenCalledTimes(directoryCount);
    expect((await originalFactory({ storageType: 'opfs' }).load({ id })).record.status).toBe('completed');
  });

  it('does not discard a pending completion save without explicit confirmation', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    const originalFactory = runStoreModule.createWorkflowRunStore;
    vi.spyOn(runStoreModule, 'createWorkflowRunStore').mockImplementation(args => {
      const store = originalFactory(args);
      return {
        ...store,
        finish: async () => {
          throw new Error('permanently unavailable');
        },
      };
    });
    const state = workspace();
    await adopt({ workspace: state, definition: { name: 'Abandoned completion', steps: [valueStep({ id: 'a', value: 'x' })] } });
    await state.start();
    const id = state.activeRunId.value!;
    const other = originalFactory({ storageType: 'opfs' });
    const durable = await other.load({ id });
    await state.discardHistorySave();
    expect(state.historySavePending.value).toBe(true);
    expect(await other.activity({ previous: durable })).toBe('active');
    mocks.confirm.mockResolvedValue(true);
    await state.discardHistorySave();
    expect(state.historySavePending.value).toBe(false);
    expect((await other.load({ id })).record.status).toBe('running');
    expect(await other.activity({ previous: durable })).toBe('recoverable');
    expect((await other.interrupt({ previous: durable })).record.status).toBe('interrupted');
  });
});

describe('Workflow history operation races', () => {
  it('stops during initial snapshot persistence before executing any steps', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    const originalFactory = runStoreModule.createWorkflowRunStore;
    const gate = Promise.withResolvers<void>();
    let requested = false;
    vi.spyOn(runStoreModule, 'createWorkflowRunStore').mockImplementation(args => {
      const store = originalFactory(args);
      return {
        ...store,
        async create(input) {
          requested = true;
          await gate.promise;
          return store.create(input);
        },
      };
    });
    const state = workspace();
    await adopt({ workspace: state, definition: { name: 'Stop before execution', steps: [valueStep({ id: 'a', value: 'never' })] } });
    const execution = state.start();
    await vi.waitFor(() => expect(requested).toBe(true));
    state.stop();
    gate.resolve();
    await execution;
    expect(state.runState.value).toBe('cancelled');
    expect(state.log.value).toEqual([]);
    expect(mocks.createTmpDirectory).not.toHaveBeenCalled();
    expect(mocks.loadLmProvider).not.toHaveBeenCalled();
    const snapshot = await originalFactory({ storageType: 'opfs' }).load({ id: state.activeRunId.value! });
    expect(snapshot.record.status).toBe('cancelled');
    expect(snapshot.record.resultsPath).toBeUndefined();
  });

  it('does not copy a snapshot after its view was replaced during discard confirmation', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    const state = workspace();
    const seedStore = createWorkflowRunStore({ storageType: 'opfs' });
    const snapshot = await seedStore.create({ workflowId: undefined, definition: { name: 'Old history', steps: [] } });
    await seedStore.release({ id: snapshot.record.id });
    state.updateName({ name: 'Keep draft' });
    const gate = Promise.withResolvers<boolean>();
    mocks.confirm.mockReturnValue(gate.promise);
    let current = true;
    const copy = state.copyRun({ snapshot, canApply: () => current });
    await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    current = false;
    gate.resolve(true);
    expect(await copy).toBe(false);
    expect(state.definition.value.name).toBe('Keep draft');
  });

  it('retains completed status and the snapshot if archiving results fails', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    const original = mocks.createTmpDirectory.getMockImplementation()!;
    mocks.createTmpDirectory.mockImplementation(async ({ prefix }: { prefix: string }) => {
      if (prefix === 'workflow-results') {
        throw new Error('result folder quota exhausted');
      }
      return original({ prefix });
    });
    const state = workspace();
    await adopt({ workspace: state, definition: { name: 'Archive failure', steps: [valueStep({ id: 'a', value: 'successful output' })] } });
    await state.start();
    const snapshot = await createWorkflowRunStore({ storageType: 'opfs' }).load({ id: state.activeRunId.value! });
    expect(snapshot.record.status).toBe('completed');
    expect(snapshot.record.definition.name).toBe('Archive failure');
    expect(snapshot.record.resultsPath).toBeUndefined();
    expect(snapshot.record.resultError).toContain('quota exhausted');
    expect(state.historySavePending.value).toBe(false);
    expect(state.hasResults.value).toBe(true);
  });

  it('refreshes the viewed running record after completion without losing editor state', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    const state = workspace();
    await adopt({
      workspace: state,
      definition: {
        name: 'Live history',
        steps: [{ ...baseStep({ id: 'ask', type: 'request_input' }), type: 'request_input', prompt: { type: 'literal', value: 'Enter text' }, responseType: 'text' }],
      },
    });
    const execution = state.start();
    await vi.waitFor(() => expect(state.pending.value).toBeDefined());
    const id = state.activeRunId.value!;
    const { wrapper, router } = await routedWorkspace({ state, path: `/workflows/runs/${idToRaw({ id })}` });
    expect(wrapper.get('[data-testid="workflow-history"]').text()).toContain('Live history');
    expect(wrapper.get('[data-testid="workflow-view"]').isVisible()).toBe(false);
    state.respond({ token: state.pending.value!.token, text: 'finished input' });
    await execution;
    await flushPromises();
    expect(wrapper.get('[data-testid="workflow-history-files"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.get('[data-testid="workflow-history"]').text()).toContain('finished input');
    await router.push('/workflows');
    await flushPromises();
    expect(state.definition.value.name).toBe('Live history');
    expect(wrapper.get('[data-testid="workflow-view"]').isVisible()).toBe(true);
  });
});

describe('Historical result downloads', () => {
  it('keeps dispatched disk-backed ZIPs and reuses them without deleting result archives', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    const state = workspace();
    await adopt({ workspace: state, definition: { name: 'ZIP lifetime', steps: [valueStep({ id: 'a', value: 'archive content' })] } });
    await state.start();
    const id = state.activeRunId.value!;
    const { router, wrapper } = await routedWorkspace({ state, path: `/workflows/runs/${idToRaw({ id })}` });
    await wrapper.get('[data-testid="workflow-history-zip"]').trigger('click');
    await vi.waitFor(() => expect(mocks.downloadFile).toHaveBeenCalledTimes(1));
    await flushPromises();
    const backing = [...files.files.keys()].filter(path => path.includes('/workflow-history-zip-'));
    expect(backing.length).toBeGreaterThan(0);
    const creations = mocks.createTmpDirectory.mock.calls.filter(([args]) => args.prefix === 'workflow-history-zip');
    expect(creations).toHaveLength(1);
    await wrapper.get('[data-testid="workflow-history-zip"]').trigger('click');
    await vi.waitFor(() => expect(mocks.downloadFile).toHaveBeenCalledTimes(2));
    expect(mocks.downloadFile.mock.calls[1]?.[0].file).toBe(mocks.downloadFile.mock.calls[0]?.[0].file);
    expect(mocks.createTmpDirectory.mock.calls.filter(([args]) => args.prefix === 'workflow-history-zip')).toHaveLength(1);
    await router.push('/workflows');
    expect(backing.every(path => files.files.has(path))).toBe(true);
  });

  it('clears an undispatched ZIP on failure without deleting the saved history or result files', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    const state = workspace();
    await adopt({ workspace: state, definition: { name: 'Failed download', steps: [valueStep({ id: 'a', value: 'retained result' })] } });
    await state.start();
    const id = state.activeRunId.value!;
    const history = await createWorkflowRunStore({ storageType: 'opfs' }).load({ id });
    const original = [...files.files.keys()].filter(path => path.startsWith(history.record.resultsPath!.join('/')));
    mocks.downloadFile.mockRejectedValue(new Error('download setup failed'));
    const { wrapper } = await routedWorkspace({ state, path: `/workflows/runs/${idToRaw({ id })}` });
    await wrapper.get('[data-testid="workflow-history-zip"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.text()).toContain('download setup failed'));
    await flushPromises();
    expect([...files.files.keys()].some(path => path.includes('/workflow-history-zip-'))).toBe(false);
    expect(original.every(path => files.files.has(path))).toBe(true);
    expect((await createWorkflowRunStore({ storageType: 'opfs' }).load({ id })).record.status).toBe('completed');
  });
});

function installWorkflowProvider() {
  const chat = vi.fn<LmProvider['chat']>(async function* () {
    yield {
      type: 'text',
      partId: 'answer',
      index: 0,
      completeness: Promise.resolve('complete'),
      chunks: (async function* () {
        yield 'answer';
      })(),
    };
    yield { type: 'result', result: { type: 'finished', next: 'user' } };
  });
  const provider: LmProvider = { listModels: async () => ['test'], chat };
  mocks.loadLmProvider.mockResolvedValue(provider);
  return { provider, chat };
}

function runningWorkflow({ state }: { state: WorkflowWorkspace }) {
  const run = state.start();
  return {
    run,
    async [Symbol.asyncDispose]() {
      state.stop();
      await run;
    },
  };
}

function temporaryWorkflowFiles({ fs }: { fs: ReturnType<typeof createWorkflowTestFileSystem> }): void {
  let index = 0;
  mocks.createTmpDirectory.mockImplementation(async () => fs.root.getDirectoryHandle(`run-${++index}`, { create: true }));
}

describe('Workflow connection review integration', () => {
  it('does not re-prompt for a model explicitly added from the current Settings connection', async () => {
    using fs = createWorkflowTestFileSystem();
    temporaryWorkflowFiles({ fs });
    const { chat } = installWorkflowProvider();
    const state = workspace();
    state.add({ type: 'text_generation', name: 'Selected current connection', target: { parentId: undefined, branch: 'root', index: 0 } });
    expect(state.definition.value.steps).toHaveLength(1);
    for (let index = 0; index < 2; index++) {
      await using pending = runningWorkflow({ state });
      await vi.waitFor(() => expect(state.runState.value).toBe('completed'));
      await pending.run;
      expect(state.pending.value).toBeUndefined();
    }
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('reviews an imported fixed target once per editing session and clears that review explicitly', async () => {
    using fs = createWorkflowTestFileSystem();
    temporaryWorkflowFiles({ fs });
    installWorkflowProvider();
    const state = workspace();
    await adopt({ workspace: state, definition: { name: '', steps: [baseStep({ type: 'text_generation', id: 'generate' })] } });
    {
      await using pending = runningWorkflow({ state });
      await vi.waitFor(() => expect(state.pending.value?.connection?.scope).toBe('editing_session'));
      expect(mocks.loadLmProvider).not.toHaveBeenCalled();
      state.respond({ token: state.pending.value!.token, text: 'allow' });
      await pending.run;
      expect(state.runState.value).toBe('completed');
    }
    {
      await using pending = runningWorkflow({ state });
      await vi.waitFor(() => expect(state.runState.value).toBe('completed'));
      await pending.run;
      expect(state.pending.value).toBeUndefined();
    }
    state.forgetModelReviews();
    {
      await using pending = runningWorkflow({ state });
      await vi.waitFor(() => expect(state.pending.value?.connection?.scope).toBe('editing_session'));
      state.respond({ token: state.pending.value!.token, text: 'deny' });
      await pending.run;
      expect(state.runState.value).toBe('failed');
    }
    expect(mocks.loadLmProvider).toHaveBeenCalledTimes(2);
  });

  it('does not bless hidden imported headers merely because the model name was edited', async () => {
    using fs = createWorkflowTestFileSystem();
    temporaryWorkflowFiles({ fs });
    installWorkflowProvider();
    const state = workspace();
    const step = baseStep({ type: 'text_generation', id: 'generate' });
    if (step.type !== 'text_generation') {
      throw new Error('fixture');
    }
    const endpoint = { type: 'ollama' as const, url: 'http://localhost:11434', httpHeaders: [['Authorization', 'do-not-show']] as [string, string][] };
    step.target = { type: 'model', endpoint, modelId: 'different' };
    await adopt({ workspace: state, definition: { name: '', steps: [step] } });
    state.reviewModel({ target: { endpoint, modelId: 'different', lmParameters: undefined } });
    await using pending = runningWorkflow({ state });
    await vi.waitFor(() => expect(state.pending.value?.connection?.scope).toBe('editing_session'));
    expect(state.pending.value?.connection?.headerNames).toEqual(['Authorization']);
    expect(JSON.stringify(state.pending.value)).not.toContain('do-not-show');
    expect(mocks.loadLmProvider).not.toHaveBeenCalled();
    state.respond({ token: state.pending.value!.token, text: 'deny' });
    await pending.run;
  });

  it('drops reviewed targets when the same definition is pasted as JSON again', async () => {
    using fs = createWorkflowTestFileSystem();
    temporaryWorkflowFiles({ fs });
    installWorkflowProvider();
    const state = workspace();
    const definition = { name: '', steps: [baseStep({ type: 'text_generation', id: 'generate' })] };
    await adopt({ workspace: state, definition });
    state.reviewModel({ target: state.defaults() });
    await adopt({ workspace: state, definition });
    await using pending = runningWorkflow({ state });
    await vi.waitFor(() => expect(state.pending.value?.connection?.scope).toBe('editing_session'));
    state.respond({ token: state.pending.value!.token, text: 'deny' });
    await pending.run;
    expect(mocks.loadLmProvider).not.toHaveBeenCalled();
  });

  it('drops fixed-target review after applying partial step JSON', async () => {
    using fs = createWorkflowTestFileSystem();
    temporaryWorkflowFiles({ fs });
    installWorkflowProvider();
    const state = workspace();
    const step = baseStep({ type: 'text_generation', id: 'generate' });
    await adopt({ workspace: state, definition: { name: '', steps: [step] } });
    state.reviewModel({ target: state.defaults() });
    state.select({ id: step.id, multiple: false });
    state.openPartial();
    state.partialDraft.value = '{"name":"Updated"}';
    state.applyPartial();
    expect(state.error.value).toBe('');
    expect(state.definition.value.steps[0]?.name).toBe('Updated');
    await using pending = runningWorkflow({ state });
    await vi.waitFor(() => expect(state.pending.value?.connection?.scope).toBe('editing_session'));
    state.respond({ token: state.pending.value!.token, text: 'deny' });
    await pending.run;
    expect(mocks.loadLmProvider).not.toHaveBeenCalled();
  });

  it('does not carry fixed-target permission into a copied history snapshot', async () => {
    using fs = createWorkflowTestFileSystem();
    historyFileSystem({ files: fs });
    installWorkflowProvider();
    const state = workspace();
    const definition = { name: 'History', steps: [baseStep({ type: 'text_generation', id: 'generate' })] };
    await adopt({ workspace: state, definition });
    state.reviewModel({ target: state.defaults() });
    const seedStore = createWorkflowRunStore({ storageType: 'opfs' });
    const snapshot = await seedStore.create({ workflowId: undefined, definition });
    await seedStore.release({ id: snapshot.record.id });
    mocks.confirm.mockResolvedValue(true);
    expect(await state.copyRun({ snapshot, canApply: () => true })).toBe(true);
    expect(state.definition.value.steps[0]?.id).not.toBe(snapshot.record.definition.steps[0]?.id);
    await using pending = runningWorkflow({ state });
    await vi.waitFor(() => expect(state.pending.value?.connection?.scope).toBe('editing_session'));
    state.respond({ token: state.pending.value!.token, text: 'deny' });
    await pending.run;
    expect(mocks.loadLmProvider).not.toHaveBeenCalled();
  });

  it('requires per-run approval of a model ID from interactive input despite a matching fixed review', async () => {
    using fs = createWorkflowTestFileSystem();
    temporaryWorkflowFiles({ fs });
    const { chat } = installWorkflowProvider();
    const state = workspace();
    const input = baseStep({ type: 'request_input', id: 'input' }), generation = baseStep({ type: 'text_generation', id: 'generate' });
    if (generation.type !== 'text_generation') {
      throw new Error('fixture');
    }
    generation.target = { type: 'json_compose', base: { endpoint: { type: 'ollama', url: 'http://localhost:11434' }, modelId: '' }, assignments: [{ path: ['modelId'], value: { type: 'step_output', stepId: input.id, output: 'value' } }] };
    await adopt({ workspace: state, definition: { name: '', steps: [input, generation] } });
    state.reviewModel({ target: state.defaults() });
    for (let index = 0; index < 2; index++) {
      await using pending = runningWorkflow({ state });
      await vi.waitFor(() => expect(state.pending.value?.kind).toBe('text'));
      state.respond({ token: state.pending.value!.token, text: 'test' });
      await vi.waitFor(() => expect(state.pending.value?.connection?.scope).toBe('run'));
      state.respond({ token: state.pending.value!.token, text: 'allow' });
      await pending.run;
      expect(state.runState.value).toBe('completed');
    }
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('checks cancellation after a delayed provider load before calling chat', async () => {
    using fs = createWorkflowTestFileSystem();
    temporaryWorkflowFiles({ fs });
    const { chat, provider } = installWorkflowProvider();
    const gate = Promise.withResolvers<LmProvider>();
    mocks.loadLmProvider.mockReturnValue(gate.promise);
    const state = workspace();
    await adopt({ workspace: state, definition: { name: '', steps: [baseStep({ type: 'text_generation', id: 'generate' })] } });
    state.reviewModel({ target: state.defaults() });
    await using pending = runningWorkflow({ state });
    await using release = {
      async [Symbol.asyncDispose]() {
        gate.resolve(provider);
        await pending.run;
      },
    };
    await vi.waitFor(() => expect(mocks.loadLmProvider).toHaveBeenCalledOnce());
    state.stop();
    await vi.waitFor(() => expect(state.runState.value).toBe('cancelled'));
    // Completion must not depend on the delayed module load finishing.
    gate.resolve(provider);
    await pending.run;
    expect(state.runState.value).toBe('cancelled');
    expect(chat).not.toHaveBeenCalled();
    expect(release).toBeDefined();
  });

  it('does not cache or load a connection when stop follows the approval answer in the same turn', async () => {
    using fs = createWorkflowTestFileSystem();
    temporaryWorkflowFiles({ fs });
    installWorkflowProvider();
    const state = workspace();
    await adopt({ workspace: state, definition: { name: '', steps: [baseStep({ type: 'text_generation', id: 'generate' })] } });
    {
      await using pending = runningWorkflow({ state });
      await vi.waitFor(() => expect(state.pending.value?.kind).toBe('approval'));
      state.respond({ token: state.pending.value!.token, text: 'allow' });
      state.stop();
      await pending.run;
      expect(state.runState.value).toBe('cancelled');
    }
    {
      await using pending = runningWorkflow({ state });
      await vi.waitFor(() => expect(state.pending.value?.kind).toBe('approval'));
      state.respond({ token: state.pending.value!.token, text: 'deny' });
      await pending.run;
    }
    expect(mocks.loadLmProvider).not.toHaveBeenCalled();
  });

  it('does not grant an already-started run new authority from editing its next target', async () => {
    using fs = createWorkflowTestFileSystem();
    temporaryWorkflowFiles({ fs });
    installWorkflowProvider();
    const state = workspace();
    await adopt({ workspace: state, definition: { name: '', steps: [baseStep({ type: 'request_input', id: 'input' }), baseStep({ type: 'text_generation', id: 'generate' })] } });
    await using pending = runningWorkflow({ state });
    await vi.waitFor(() => expect(state.pending.value?.kind).toBe('text'));
    state.reviewModel({ target: state.defaults() });
    state.respond({ token: state.pending.value!.token, text: 'continue' });
    await vi.waitFor(() => expect(state.pending.value?.connection?.scope).toBe('editing_session'));
    state.respond({ token: state.pending.value!.token, text: 'deny' });
    await pending.run;
    expect(mocks.loadLmProvider).not.toHaveBeenCalled();
  });

  it('connects an explicit model selection in the real editor to fixed-target review', async () => {
    using fs = createWorkflowTestFileSystem();
    temporaryWorkflowFiles({ fs });
    const { chat } = installWorkflowProvider();
    const state = workspace();
    const step = baseStep({ type: 'text_generation', id: 'generate' });
    await adopt({ workspace: state, definition: { name: '', steps: [step] } });
    state.select({ id: step.id, multiple: false });
    vi.spyOn(workspaceModule, 'useWorkflowWorkspace').mockReturnValue(state);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workflows', component: WorkflowView }] });
    await router.push('/workflows');
    await router.isReady();
    const wrapper = mount({ template: '<router-view />' }, { global: { plugins: [router] } });
    wrappers.push(wrapper);
    await flushPromises();
    await wrapper.get('[data-testid="workflow-model-id"]').setValue('chosen');
    await using pending = runningWorkflow({ state });
    await vi.waitFor(() => expect(state.runState.value).toBe('completed'));
    await pending.run;
    expect(state.pending.value).toBeUndefined();
    expect(chat).toHaveBeenCalledOnce();
    await wrapper.get('[data-testid="workflow-forget-model-reviews"]').trigger('click');
    await using next = runningWorkflow({ state });
    await vi.waitFor(() => expect(state.pending.value?.connection?.modelId).toBe('chosen'));
    expect(wrapper.find('[data-testid="workflow-connection-details"]').exists()).toBe(true);
    state.respond({ token: state.pending.value!.token, text: 'deny' });
    await next.run;
  });
});

describe('Workflow audio authorization and history', () => {
  it('requires a separate audio approval even after fixed text approval for the same local model', async () => {
    using fs = createWorkflowTestFileSystem();
    temporaryWorkflowFiles({ fs });
    const state = workspace();
    await adopt({ workspace: state, definition: { name: 'Voice', steps: [audioStep({ id: 'voice' })] } });
    // Import a local setting solely to verify that a valid text review does not authorize audio.
    const previous = settings.value.endpoint;
    Object.assign(settings.value, { endpoint: { type: 'llama_cpp_browser' } });
    using restore = {
      [Symbol.dispose]() {
        settings.value.endpoint = previous;
      },
    };
    void restore;
    state.reviewModel({ target: { endpoint: { type: 'llama_cpp_browser' }, modelId: 'voice.gguf', lmParameters: undefined } });
    await using pending = runningWorkflow({ state });
    await vi.waitFor(() => expect(state.pending.value?.kind).toBe('approval'));
    expect(state.pending.value?.title).toBe('Allow local audio generation?');
    expect(state.pending.value?.connection?.scope).toBe('editing_session');
    expect(mocks.generateAudio).not.toHaveBeenCalled();
    state.respond({ token: state.pending.value!.token, text: 'deny' });
    await pending.run;
    expect(state.runState.value).toBe('failed');
    expect(mocks.generateAudio).not.toHaveBeenCalled();
  });

  it('uses an explicit local audio selection without repeated confirmation and allows forgetting it', async () => {
    using fs = createWorkflowTestFileSystem();
    temporaryWorkflowFiles({ fs });
    mocks.generateAudio.mockResolvedValue(audioResult({ samples: 4, finishReason: 'stop' }));
    const state = workspace();
    await adopt({ workspace: state, definition: { name: 'Voice', steps: [audioStep({ id: 'voice' })] } });
    state.reviewAudioModel({ modelId: 'voice.gguf' });
    for (let index = 0; index < 2; index++) {
      await using pending = runningWorkflow({ state });
      await pending.run;
      expect(state.runState.value).toBe('completed');
      expect(state.pending.value).toBeUndefined();
    }
    expect(mocks.generateAudio).toHaveBeenCalledTimes(2);
    expect(state.log.value[0]?.inputPreview).toBe('Hello');
    state.forgetModelReviews();
    await using pending = runningWorkflow({ state });
    await vi.waitFor(() => expect(state.pending.value?.kind).toBe('approval'));
    state.respond({ token: state.pending.value!.token, text: 'deny' });
    await pending.run;
    expect(mocks.generateAudio).toHaveBeenCalledTimes(2);
  });

  it('does not extend audio authority to dynamically supplied model names on later runs', async () => {
    using fs = createWorkflowTestFileSystem();
    temporaryWorkflowFiles({ fs });
    mocks.generateAudio.mockResolvedValue(audioResult({ samples: 4, finishReason: 'stop' }));
    const state = workspace();
    const input = baseStep({ id: 'input', type: 'request_input' });
    const step = { ...audioStep({ id: 'voice' }), modelId: reference({ id: 'input', output: 'value' }) };
    await adopt({ workspace: state, definition: { name: 'Dynamic voice', steps: [input, step] } });
    state.reviewAudioModel({ modelId: 'voice.gguf' });
    for (let index = 0; index < 2; index++) {
      await using pending = runningWorkflow({ state });
      await vi.waitFor(() => expect(state.pending.value?.kind).toBe('text'));
      state.respond({ token: state.pending.value!.token, text: 'voice.gguf' });
      await vi.waitFor(() => expect(state.pending.value?.connection?.scope).toBe('run'));
      expect(state.pending.value?.connection?.sources).toContain('interactive_input');
      state.respond({ token: state.pending.value!.token, text: 'allow' });
      await pending.run;
      expect(state.runState.value).toBe('completed');
    }
    expect(mocks.generateAudio).toHaveBeenCalledTimes(2);
  });

  it('clears audio authority on whole-document and partial JSON application', async () => {
    using fs = createWorkflowTestFileSystem();
    temporaryWorkflowFiles({ fs });
    const state = workspace();
    const step = audioStep({ id: 'voice' });
    const definition = { name: '', steps: [step] };
    await adopt({ workspace: state, definition });
    state.reviewAudioModel({ modelId: 'voice.gguf' });
    await adopt({ workspace: state, definition });
    {
      await using pending = runningWorkflow({ state });
      await vi.waitFor(() => expect(state.pending.value?.kind).toBe('approval'));
      state.respond({ token: state.pending.value!.token, text: 'deny' });
      await pending.run;
    }
    state.reviewAudioModel({ modelId: 'voice.gguf' });
    state.select({ id: step.id, multiple: false });
    state.openPartial();
    state.partialDraft.value = JSON.stringify({ text: literal({ value: 'Changed' }) });
    state.applyPartial();
    await using pending = runningWorkflow({ state });
    await vi.waitFor(() => expect(state.pending.value?.kind).toBe('approval'));
    state.respond({ token: state.pending.value!.token, text: 'deny' });
    await pending.run;
    expect(mocks.generateAudio).not.toHaveBeenCalled();
  });

  it('does not authorize an active run through later audio selection', async () => {
    using fs = createWorkflowTestFileSystem();
    temporaryWorkflowFiles({ fs });
    const state = workspace();
    await adopt({ workspace: state, definition: { name: '', steps: [baseStep({ type: 'request_input', id: 'input' }), audioStep({ id: 'voice' })] } });
    await using pending = runningWorkflow({ state });
    await vi.waitFor(() => expect(state.pending.value?.kind).toBe('text'));
    state.reviewAudioModel({ modelId: 'voice.gguf' });
    state.respond({ token: state.pending.value!.token, text: 'continue' });
    await vi.waitFor(() => expect(state.pending.value?.kind).toBe('approval'));
    state.respond({ token: state.pending.value!.token, text: 'deny' });
    await pending.run;
    expect(mocks.generateAudio).not.toHaveBeenCalled();
  });

  it('waits for native cancellation and does not publish late audio', async () => {
    using fs = createWorkflowTestFileSystem();
    temporaryWorkflowFiles({ fs });
    const state = workspace();
    await adopt({ workspace: state, definition: { name: '', steps: [audioStep({ id: 'voice' })] } });
    state.reviewAudioModel({ modelId: 'voice.gguf' });
    const gate = Promise.withResolvers<ReturnType<typeof audioResult>>();
    mocks.generateAudio.mockReturnValue(gate.promise);
    await using pending = runningWorkflow({ state });
    using settle = {
      [Symbol.dispose]() {
        gate.resolve(audioResult({ samples: 4, finishReason: 'stop' }));
      },
    };
    void settle;
    await vi.waitFor(() => expect(mocks.generateAudio).toHaveBeenCalledOnce());
    state.stop();
    expect(mocks.generateAudio.mock.calls[0]![0].cancellationSignal.aborted).toBe(true);
    expect(state.running.value).toBe(true);
    gate.resolve(audioResult({ samples: 4, finishReason: 'stop' }));
    await pending.run;
    expect(state.runState.value).toBe('cancelled');
    // A cancelled run retains its status record, but no unfinished output.
    expect(state.log.value.every(entry => entry.phase === 'running')).toBe(true);
    expect([...fs.files.keys()].some(path => path.endsWith('.wav'))).toBe(false);
  });

  it('persists the audio snapshot and archived WAV without granting its copied definition authority', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    mocks.generateAudio.mockResolvedValue(audioResult({ samples: 4, finishReason: 'frame-limit' }));
    const state = workspace();
    const step = { ...audioStep({ id: 'voice' }), onLimit: 'keep' as const };
    await adopt({ workspace: state, definition: { name: 'Incomplete voice', steps: [step] } });
    state.reviewAudioModel({ modelId: 'voice.gguf' });
    await state.start();
    expect(state.runState.value).toBe('completed');
    const snapshot = await createWorkflowRunStore({ storageType: 'opfs' }).load({ id: state.activeRunId.value! });
    expect(snapshot.record.definition.steps[0]).toEqual(step);
    expect(snapshot.record.entries[0]?.preview).toContain('complete: false');
    expect([...files.files.keys()].some(path => path.endsWith('.wav'))).toBe(true);
    mocks.confirm.mockResolvedValue(true);
    await state.copyRun({ snapshot, canApply: () => true });
    await using pending = runningWorkflow({ state });
    await vi.waitFor(() => expect(state.pending.value?.kind).toBe('approval'));
    state.respond({ token: state.pending.value!.token, text: 'deny' });
    await pending.run;
    expect(mocks.generateAudio).toHaveBeenCalledOnce();
  });
});

describe('Workflow binary reference audio', () => {
  it('reads a WAV file, skips only its invalid text view, and archives generated audio', async () => {
    using input = createWorkflowTestFileSystem();
    using history = createWorkflowTestFileSystem();
    historyFileSystem({ files: history });
    const native = audioResult({ samples: 4, finishReason: 'stop' });
    input.files.set('voice.wav', native.wav.slice());
    mocks.resolveVolumeAccess.mockResolvedValue({ kind: 'native', handle: input.root });
    const normalized = new Blob([native.wav.slice().buffer], { type: 'audio/wav' });
    mocks.normalizeReference.mockResolvedValue({ wav: normalized, samples: 4, trimmed: false });
    mocks.generateAudio.mockResolvedValue(native);
    const state = workspace();
    const source = { id: stepId({ raw: 'source' }), name: 'Reference', type: 'read_file' as const, volumeId: toVolumeId({ raw: 'voice-volume' }), relativePath: literal({ value: 'voice.wav' }) };
    const voice = { ...audioStep({ id: 'voice' }), reference: reference({ id: 'source', output: 'content' }) };
    await adopt({ workspace: state, definition: { name: 'Reference voice', steps: [source, voice] } });
    expect(state.error.value).toBe('');
    state.reviewAudioModel({ modelId: 'voice.gguf' });
    await using pending = runningWorkflow({ state });
    await vi.waitFor(() => expect(state.pending.value?.kind).toBe('approval'));
    state.respond({ token: state.pending.value!.token, text: 'allow' });
    await pending.run;
    expect(state.runState.value).toBe('completed');
    expect(mocks.normalizeReference).toHaveBeenCalledWith(expect.objectContaining({ durationPolicy: 'reject' }));
    expect(mocks.generateAudio.mock.calls[0]?.[0].input.reference).toBe(normalized);
    expect(state.log.value.find(entry => entry.stepId === source.id)?.preview).toContain('not valid UTF-8 text');
    expect(state.historyError.value).toBe('');
    const snapshot = await createWorkflowRunStore({ storageType: 'opfs' }).load({ id: state.activeRunId.value! });
    expect(snapshot.record.status).toBe('completed');
    const manifestBytes = [...history.files.entries()].find(([path]) => path.endsWith('/index.json') && new TextDecoder().decode(history.files.get(path)!).includes('source'))?.[1];
    expect(manifestBytes).toBeDefined();
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    expect(manifest.outputs).toContainEqual({ stepId: 'source', output: 'text', path: null, skipped: 'Output is not valid UTF-8 text.' });
    expect([...history.files.keys()].some(path => path.endsWith('.wav'))).toBe(true);
    expect([...history.files.keys()].some(path => path.endsWith('result-0002.txt'))).toBe(false);
    expect(input.files.get('voice.wav')).toEqual(native.wav);
  });
});

describe('Workflow audio permission boundaries', () => {
  it('does not use an audio review to authorize a text connection', async () => {
    using files = createWorkflowTestFileSystem();
    temporaryWorkflowFiles({ fs: files });
    const state = workspace();
    const step = baseStep({ type: 'text_generation', id: 'text' });
    if (step.type !== 'text_generation') {
      throw new Error('Expected text step fixture.');
    }
    step.target = { type: 'model', endpoint: { type: 'llama_cpp_browser' }, modelId: 'voice.gguf' };
    await adopt({ workspace: state, definition: { name: '', steps: [step] } });
    state.reviewAudioModel({ modelId: 'voice.gguf' });
    await using pending = runningWorkflow({ state });
    await vi.waitFor(() => expect(state.pending.value?.kind).toBe('approval'));
    expect(state.pending.value?.title).not.toBe('Allow local audio generation?');
    expect(mocks.loadLmProvider).not.toHaveBeenCalled();
    state.respond({ token: state.pending.value!.token, text: 'deny' });
    await pending.run;
    expect(mocks.loadLmProvider).not.toHaveBeenCalled();
  });

  it('does not generate or remember an audio approval cancelled in the same turn', async () => {
    using files = createWorkflowTestFileSystem();
    temporaryWorkflowFiles({ fs: files });
    const state = workspace();
    await adopt({ workspace: state, definition: { name: '', steps: [audioStep({ id: 'voice' })] } });
    {
      await using pending = runningWorkflow({ state });
      await vi.waitFor(() => expect(state.pending.value?.kind).toBe('approval'));
      state.respond({ token: state.pending.value!.token, text: 'allow' });
      state.stop();
      await pending.run;
      expect(state.runState.value).toBe('cancelled');
      expect(mocks.generateAudio).not.toHaveBeenCalled();
    }
    await using pending = runningWorkflow({ state });
    await vi.waitFor(() => expect(state.pending.value?.kind).toBe('approval'));
    state.respond({ token: state.pending.value!.token, text: 'deny' });
    await pending.run;
    expect(mocks.generateAudio).not.toHaveBeenCalled();
  });

  it('connects an explicit selection in the real audio editor to the audio-only review', async () => {
    using files = createWorkflowTestFileSystem();
    temporaryWorkflowFiles({ fs: files });
    mocks.generateAudio.mockResolvedValue(audioResult({ samples: 4, finishReason: 'stop' }));
    const state = workspace();
    const step = audioStep({ id: 'voice' });
    await adopt({ workspace: state, definition: { name: '', steps: [step] } });
    state.select({ id: step.id, multiple: false });
    vi.spyOn(workspaceModule, 'useWorkflowWorkspace').mockReturnValue(state);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workflows', component: WorkflowView }] });
    await router.push('/workflows');
    await router.isReady();
    const wrapper = mount({ template: '<router-view />' }, { global: { plugins: [router] } });
    wrappers.push(wrapper);
    await flushPromises();
    await wrapper.get('[data-testid="workflow-audio-model-id"]').setValue('chosen-voice.gguf');
    await using pending = runningWorkflow({ state });
    await pending.run;
    expect(state.runState.value).toBe('completed');
    expect(state.pending.value).toBeUndefined();
    expect(mocks.generateAudio.mock.calls[0]?.[0].input.modelId).toBe('chosen-voice.gguf');
  });
});

describe('Workflow image authorization, cancellation and history', () => {
  beforeEach(() => {
    vi.stubGlobal('Blob', NodeBlob);
    mocks.createImageProvider.mockImplementation(() => ({ generate: mocks.generateImage, close: mocks.closeImage }));
    mocks.generateImage.mockImplementation(async () => ({ result: imageResult({ width: 256, height: 256, compression: 'small' }), profile: 'webgpu-wasm32-asyncify' }));
  });

  it('requires image-specific approval before creating a provider, even after approving audio', async () => {
    using fs = createWorkflowTestFileSystem();
    temporaryWorkflowFiles({ fs });
    const state = workspace();
    await adopt({ workspace: state, definition: { name: '', steps: [imageStep({ id: 'image' })] } });
    state.reviewAudioModel({ modelId: 'models/user/example/model.gguf' });
    await using pending = runningWorkflow({ state });
    await vi.waitFor(() => expect(state.pending.value?.kind).toBe('approval'));
    expect(state.pending.value?.title).toBe('Allow this local image model?');
    expect(state.pending.value?.connection?.modelId).toContain('models/user/example/model.gguf');
    expect(mocks.createImageProvider).not.toHaveBeenCalled();
    state.respond({ token: state.pending.value!.token, text: 'deny' });
    await pending.run;
    expect(state.runState.value).toBe('failed');
    expect(mocks.generateImage).not.toHaveBeenCalled();
  });

  it('uses explicit fixed selections across runs but creates and retires a distinct provider for each run', async () => {
    using fs = createWorkflowTestFileSystem();
    temporaryWorkflowFiles({ fs });
    const state = workspace();
    await adopt({ workspace: state, definition: { name: '', steps: [imageStep({ id: 'image' })] } });
    state.reviewImageModel({ selection: imageSelection() });
    for (let index = 0; index < 2; index++) {
      await state.start();
      expect(state.runState.value).toBe('completed');
    }
    expect(mocks.createImageProvider).toHaveBeenCalledTimes(2);
    expect(mocks.closeImage).toHaveBeenCalledTimes(2);
    expect(state.log.value[0]?.inputPreview).toBe('A tree');
    state.forgetModelReviews();
    await using pending = runningWorkflow({ state });
    await vi.waitFor(() => expect(state.pending.value?.kind).toBe('approval'));
    state.respond({ token: state.pending.value!.token, text: 'deny' });
    await pending.run;
    expect(mocks.generateImage).toHaveBeenCalledTimes(2);
  });

  it('requires a run-local approval for an input-derived model even when it matches a fixed reviewed selection', async () => {
    using fs = createWorkflowTestFileSystem();
    temporaryWorkflowFiles({ fs });
    const state = workspace(), input = baseStep({ id: 'input', type: 'request_input' });
    if (input.type !== 'request_input') {
      throw new Error('Expected request input');
    }
    input.responseType = 'json';
    const image = imageStep({ id: 'image' });
    image.model = reference({ id: 'input', output: 'value' });
    await adopt({ workspace: state, definition: { name: '', steps: [input, image] } });
    state.reviewImageModel({ selection: imageSelection() });
    for (let index = 0; index < 2; index++) {
      await using pending = runningWorkflow({ state });
      await vi.waitFor(() => expect(state.pending.value?.kind).toBe('json'));
      state.respond({ token: state.pending.value!.token, text: JSON.stringify(imageSelection()) });
      await vi.waitFor(() => expect(state.pending.value?.connection?.scope).toBe('run'));
      expect(state.pending.value?.connection?.sources).toContain('interactive_input');
      state.respond({ token: state.pending.value!.token, text: 'allow' });
      await pending.run;
      expect(state.runState.value).toBe('completed');
    }
  });

  it('clears image approvals after both document JSON and partial JSON application', async () => {
    using fs = createWorkflowTestFileSystem();
    temporaryWorkflowFiles({ fs });
    const state = workspace(), step = imageStep({ id: 'image' }), definition = { name: '', steps: [step] };
    await adopt({ workspace: state, definition });
    for (const mode of ['document', 'partial']) {
      state.reviewImageModel({ selection: imageSelection() });
      if (mode === 'document') {
        await adopt({ workspace: state, definition });
      } else {
        state.select({ id: step.id, multiple: false });
        state.openPartial();
        state.partialDraft.value = JSON.stringify({ prompt: literal({ value: 'Changed' }) });
        state.applyPartial();
      }
      await using pending = runningWorkflow({ state });
      await vi.waitFor(() => expect(state.pending.value?.kind).toBe('approval'));
      state.respond({ token: state.pending.value!.token, text: 'deny' });
      await pending.run;
    }
    expect(mocks.generateImage).not.toHaveBeenCalled();
  });

  it('does not add a later image review to the permissions of an already-started run', async () => {
    using fs = createWorkflowTestFileSystem();
    temporaryWorkflowFiles({ fs });
    const state = workspace();
    await adopt({ workspace: state, definition: { name: '', steps: [baseStep({ id: 'pause', type: 'request_input' }), imageStep({ id: 'image' })] } });
    await using pending = runningWorkflow({ state });
    await vi.waitFor(() => expect(state.pending.value?.kind).toBe('text'));
    state.reviewImageModel({ selection: imageSelection() });
    state.respond({ token: state.pending.value!.token, text: 'continue' });
    await vi.waitFor(() => expect(state.pending.value?.kind).toBe('approval'));
    state.respond({ token: state.pending.value!.token, text: 'deny' });
    await pending.run;
    expect(mocks.generateImage).not.toHaveBeenCalled();
  });

  it('does not retire a running engine or publish its late image after Stop', async () => {
    using fs = createWorkflowTestFileSystem();
    temporaryWorkflowFiles({ fs });
    const state = workspace();
    await adopt({ workspace: state, definition: { name: '', steps: [imageStep({ id: 'image' })] } });
    state.reviewImageModel({ selection: imageSelection() });
    const gate = Promise.withResolvers<{ result: ReturnType<typeof imageResult>, profile: 'webgpu-wasm32-asyncify' }>();
    mocks.generateImage.mockReturnValue(gate.promise);
    await using pending = runningWorkflow({ state });
    using settle = {
      [Symbol.dispose]() {
        gate.resolve({ result: imageResult({ width: 256, height: 256, compression: 'small' }), profile: 'webgpu-wasm32-asyncify' });
      },
    };
    void settle;
    await vi.waitFor(() => expect(mocks.generateImage).toHaveBeenCalledOnce());
    state.stop();
    expect(mocks.generateImage.mock.calls[0]![0].signal.aborted).toBe(true);
    expect(mocks.closeImage).not.toHaveBeenCalled();
    expect(state.running.value).toBe(true);
    gate.resolve({ result: imageResult({ width: 256, height: 256, compression: 'small' }), profile: 'webgpu-wasm32-asyncify' });
    await pending.run;
    expect(state.runState.value).toBe('cancelled');
    expect(mocks.closeImage).toHaveBeenCalledOnce();
    expect([...fs.files.keys()].some(path => path.endsWith('.png'))).toBe(false);
  });

  it('archives PNG results and definition snapshots without granting permission to a copied history', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    const state = workspace(), step = imageStep({ id: 'image' });
    await adopt({ workspace: state, definition: { name: 'Picture', steps: [step] } });
    state.reviewImageModel({ selection: imageSelection() });
    await state.start();
    expect(state.runState.value).toBe('completed');
    const snapshot = await createWorkflowRunStore({ storageType: 'opfs' }).load({ id: state.activeRunId.value! });
    expect(snapshot.record.definition.steps[0]).toEqual(step);
    const png = [...files.files.entries()].find(([path]) => path.endsWith('.png'))?.[1];
    expect(png?.slice(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    mocks.confirm.mockResolvedValue(true);
    await state.copyRun({ snapshot, canApply: () => true });
    await using pending = runningWorkflow({ state });
    await vi.waitFor(() => expect(state.pending.value?.kind).toBe('approval'));
    state.respond({ token: state.pending.value!.token, text: 'deny' });
    await pending.run;
    expect(mocks.generateImage).toHaveBeenCalledOnce();
  });

  it('finalizes a failed history and retains completed output when owner retirement throws', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    const state = workspace();
    await adopt({ workspace: state, definition: { name: '', steps: [imageStep({ id: 'image' })] } });
    state.reviewImageModel({ selection: imageSelection() });
    mocks.closeImage.mockImplementationOnce(() => {
      throw new Error('retirement failed');
    });
    await state.start();
    expect(state.runState.value).toBe('failed');
    const snapshot = await createWorkflowRunStore({ storageType: 'opfs' }).load({ id: state.activeRunId.value! });
    expect(snapshot.record.status).toBe('failed');
    expect(snapshot.record.error).toContain('retirement failed');
    expect([...files.files.keys()].some(path => path.endsWith('.png'))).toBe(true);
  });
});

describe('Explicit workflow tools', () => {
  beforeEach(() => {
    mocks.executeTool.mockResolvedValue({ outcome: { status: 'success', content: 'tool result' }, metadata: {} });
  });

  it('does not reuse a tool review for an identical call or for a later run', async () => {
    using fs = createWorkflowTestFileSystem();
    temporaryWorkflowFiles({ fs });
    const state = workspace();
    const request = toolRequest({ name: 'wikipedia_search' });
    await adopt({ workspace: state, definition: { name: 'Repeated search', steps: [toolStep({ id: 'first', request, onError: 'fail' }), toolStep({ id: 'second', request, onError: 'fail' })] } });
    for (let iteration = 0; iteration < 2; iteration++) {
      await using pending = runningWorkflow({ state });
      for (let call = 0; call < 2; call++) {
        await vi.waitFor(() => expect(state.pending.value?.kind).toBe('approval'));
        expect(state.pending.value?.prompt).toContain('https://en.wikipedia.org/w/api.php');
        expect(mocks.executeTool).toHaveBeenCalledTimes(iteration * 2 + call);
        const token = state.pending.value!.token;
        state.respond({ token, text: 'allow' });
        await vi.waitFor(() => expect(mocks.executeTool).toHaveBeenCalledTimes(iteration * 2 + call + 1));
        await vi.waitFor(() => expect(state.pending.value?.token).not.toBe(token));
      }
      await pending.run;
      expect(state.runState.value).toBe('completed');
    }
  });

  it('shows the entire shell request before any shell is opened and denial cannot be continued past', async () => {
    using fs = createWorkflowTestFileSystem();
    temporaryWorkflowFiles({ fs });
    const state = workspace();
    const request = toolRequest({ name: 'shell_execute' });
    if (request.name !== 'shell_execute') {
      throw new Error('Expected shell');
    }
    request.args.shell_script = `# ${'x'.repeat(5000)}\nprintf end-of-reviewed-script`;
    await adopt({ workspace: state, definition: { name: '', steps: [toolStep({ id: 'shell', request, onError: 'continue' }), valueStep({ id: 'after', value: 'must not run' })] } });
    await using pending = runningWorkflow({ state });
    await vi.waitFor(() => expect(state.pending.value?.kind).toBe('approval'));
    expect(state.pending.value?.prompt).toContain('end-of-reviewed-script');
    expect(state.pending.value?.prompt).toContain('read-only');
    expect(state.pending.value?.prompt).toContain('8000');
    expect(mocks.executeTool).not.toHaveBeenCalled();
    state.respond({ token: state.pending.value!.token, text: 'deny' });
    await pending.run;
    expect(state.runState.value).toBe('failed');
    expect(mocks.executeTool).not.toHaveBeenCalled();
    expect(state.log.value.some(entry => entry.stepId === stepId({ raw: 'after' }))).toBe(false);
  });

  it('does not use an accepted response arriving in the same turn as cancellation', async () => {
    using fs = createWorkflowTestFileSystem();
    temporaryWorkflowFiles({ fs });
    const state = workspace();
    await adopt({ workspace: state, definition: { name: '', steps: [toolStep({ id: 'search', request: toolRequest({ name: 'wikipedia_search' }), onError: 'fail' })] } });
    await using pending = runningWorkflow({ state });
    await vi.waitFor(() => expect(state.pending.value?.kind).toBe('approval'));
    state.respond({ token: state.pending.value!.token, text: 'allow' });
    state.stop();
    await pending.run;
    expect(state.runState.value).toBe('cancelled');
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });

  it.each(['fail', 'continue'] as const)('archives a calculator tool error according to the explicit %s policy', async onError => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    const state = workspace();
    const step = toolStep({ id: 'calculate', request: toolRequest({ name: 'calculator' }), onError });
    mocks.executeTool.mockResolvedValue({ outcome: { status: 'error', code: 'execution_failed', message: 'Undefined calculation' }, metadata: {} });
    await adopt({ workspace: state, definition: { name: 'Tool failure', steps: [step, valueStep({ id: 'after', value: 'continued' })] } });
    await state.start();
    expect(state.pending.value).toBeUndefined();
    expect(state.runState.value).toBe(onError === 'continue' ? 'completed' : 'failed');
    const snapshot = await createWorkflowRunStore({ storageType: 'opfs' }).load({ id: state.activeRunId.value! });
    expect(snapshot.record.status).toBe(onError === 'continue' ? 'completed' : 'failed');
    expect(snapshot.record.definition.steps[0]).toEqual(step);
    if (onError === 'continue') {
      expect(snapshot.record.entries[0]?.preview).toContain('ok: false');
      expect([...files.files.values()].some(bytes => new TextDecoder().decode(bytes).includes('Undefined calculation'))).toBe(true);
      expect(snapshot.record.entries.some(entry => entry.stepId === stepId({ raw: 'after' }))).toBe(true);
    } else {
      expect(snapshot.record.entries.some(entry => entry.stepId === stepId({ raw: 'after' }))).toBe(false);
    }
  });

  it('drains a running tool after stop and records cancellation without publishing its late output', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    const state = workspace();
    const gate = Promise.withResolvers<WorkflowToolExecution>();
    mocks.executeTool.mockReturnValue(gate.promise);
    await adopt({ workspace: state, definition: { name: '', steps: [toolStep({ id: 'calculate', request: toolRequest({ name: 'calculator' }), onError: 'continue' })] } });
    await using pending = runningWorkflow({ state });
    await using settle = {
      async [Symbol.asyncDispose]() {
        gate.resolve({ outcome: { status: 'success', content: 'late-private-tool-output' }, metadata: {} });
      },
    };
    await vi.waitFor(() => expect(mocks.executeTool).toHaveBeenCalledOnce());
    state.stop();
    await flushPromises();
    expect(state.running.value).toBe(true);
    expect(mocks.executeTool.mock.calls[0]?.[0].signal.aborted).toBe(true);
    gate.resolve({ outcome: { status: 'success', content: 'late-private-tool-output' }, metadata: {} });
    await pending.run;
    expect(state.runState.value).toBe('cancelled');
    const snapshot = await createWorkflowRunStore({ storageType: 'opfs' }).load({ id: state.activeRunId.value! });
    expect(snapshot.record.status).toBe('cancelled');
    expect([...files.files.values()].some(bytes => new TextDecoder().decode(bytes).includes('late-private-tool-output'))).toBe(false);
    void settle;
  });

  it('copies a tool run into an editable definition without inheriting its previous permission', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    const state = workspace();
    await adopt({ workspace: state, definition: { name: 'Search', steps: [toolStep({ id: 'search', request: toolRequest({ name: 'wikipedia_search' }), onError: 'fail' })] } });
    {
      await using pending = runningWorkflow({ state });
      await vi.waitFor(() => expect(state.pending.value?.kind).toBe('approval'));
      state.respond({ token: state.pending.value!.token, text: 'allow' });
      await pending.run;
    }
    const snapshot = await createWorkflowRunStore({ storageType: 'opfs' }).load({ id: state.activeRunId.value! });
    mocks.confirm.mockResolvedValue(true);
    await state.copyRun({ snapshot, canApply: () => true });
    await using pending = runningWorkflow({ state });
    await vi.waitFor(() => expect(state.pending.value?.kind).toBe('approval'));
    state.respond({ token: state.pending.value!.token, text: 'deny' });
    await pending.run;
    expect(mocks.executeTool).toHaveBeenCalledOnce();
  });
});

describe('Workflow graph workspace transactions', () => {
  function request({ state }: { state: WorkflowWorkspace }) {
    return {
      definition: state.definition.value,
      edit: { type: 'connect' as const, stepId: stepId({ raw: 'b' }), location: ['value'], previous: literal({ value: 'B' }), reference: reference({ id: 'a', output: 'value' }) },
    };
  }

  async function graphState() {
    const state = workspace();
    await adopt({ workspace: state, definition: { name: 'Graph', steps: [valueStep({ id: 'a', value: 'A' }), valueStep({ id: 'b', value: 'B' })] } });
    await state.changeMode({ next: 'graph' });
    state.select({ id: stepId({ raw: 'b' }), multiple: false });
    return state;
  }

  it('commits a graph connection to the same definition, undo stack and JSON editor', async () => {
    const state = await graphState();
    state.editGraph(request({ state }));
    expect(state.error.value).toBe('');
    expect(state.mode.value).toBe('graph');
    expect(state.selected.value).toMatchObject({ value: reference({ id: 'a', output: 'value' }) });
    state.travel({ direction: 'undo' });
    expect(state.selected.value).toMatchObject({ value: literal({ value: 'B' }) });
    state.travel({ direction: 'redo' });
    await state.changeMode({ next: 'json' });
    expect(JSON.parse(state.jsonDraft.value).steps[1].value).toEqual(reference({ id: 'a', output: 'value' }));
  });

  it('rejects a request from before another edit even if the input is unchanged', async () => {
    const state = await graphState();
    const old = request({ state });
    state.updateName({ name: 'newer' });
    const current = state.definition.value;
    state.editGraph(old);
    expect(state.definition.value).toBe(current);
    expect(state.selected.value).toMatchObject({ value: literal({ value: 'B' }) });
  });

  it('rejects a request from an earlier document with reused Step IDs', async () => {
    const state = await graphState();
    const old = request({ state });
    await adopt({ workspace: state, definition: { name: 'different', steps: [valueStep({ id: 'a', value: 'C' }), valueStep({ id: 'b', value: 'B' })] } });
    const current = state.definition.value;
    state.editGraph(old);
    expect(state.definition.value).toBe(current);
  });

  it('protects inline drafts, partial JSON and raw JSON from graph events', async () => {
    const state = await graphState();
    const owner = Symbol('graph-draft');
    state.inlineDrafts.update({ owner, text: '-', discard: () => undefined });
    const current = state.definition.value;
    state.editGraph(request({ state }));
    expect(state.definition.value).toBe(current);
    state.inlineDrafts.update({ owner, text: undefined, discard: () => undefined });
    state.openPartial();
    state.editGraph(request({ state }));
    expect(state.definition.value).toBe(current);
    await state.closePartial();
    await state.changeMode({ next: 'json' });
    state.editGraph(request({ state }));
    expect(state.definition.value).toBe(current);
  });

  it('keeps the definition and history intact after an invalid move', async () => {
    const state = await graphState();
    state.editGraph(request({ state }));
    const current = state.definition.value;
    state.editGraph({ definition: current, edit: { type: 'move', stepId: stepId({ raw: 'a' }), target: { parentId: undefined, branch: 'root', index: 2 } } });
    expect(state.definition.value).toBe(current);
    expect(state.error.value).not.toBe('');
    state.travel({ direction: 'undo' });
    expect(state.selected.value).toMatchObject({ value: literal({ value: 'B' }) });
  });

  it('does not record no-op moves in history', async () => {
    const state = await graphState();
    state.editGraph(request({ state }));
    const current = state.definition.value;
    state.editGraph({ definition: current, edit: { type: 'move', stepId: stepId({ raw: 'a' }), target: { parentId: undefined, branch: 'root', index: 0 } } });
    expect(state.definition.value).toBe(current);
    state.travel({ direction: 'undo' });
    expect(state.selected.value).toMatchObject({ value: literal({ value: 'B' }) });
  });

  it('does not grant model authority by connecting a model-valued Step', async () => {
    using fs = createWorkflowTestFileSystem();
    temporaryWorkflowFiles({ fs });
    installWorkflowProvider();
    const state = workspace();
    const model = { ...valueStep({ id: 'model', value: '' }), value: { type: 'model' as const, endpoint: state.defaults().endpoint, modelId: 'not-reviewed' } };
    const generation = baseStep({ type: 'text_generation', id: 'generate' });
    if (generation.type !== 'text_generation') {
      throw new Error('fixture');
    }
    await adopt({ workspace: state, definition: { name: '', steps: [model, generation] } });
    await state.changeMode({ next: 'graph' });
    state.editGraph({ definition: state.definition.value, edit: { type: 'connect', stepId: generation.id, location: ['target'], previous: generation.target, reference: reference({ id: 'model', output: 'value' }) } });
    expect(state.error.value).toBe('');
    await using pending = runningWorkflow({ state });
    await vi.waitFor(() => expect(state.pending.value?.connection?.modelId).toBe('not-reviewed'));
    expect(mocks.loadLmProvider).not.toHaveBeenCalled();
    state.respond({ token: state.pending.value!.token, text: 'deny' });
    await pending.run;
    expect(mocks.loadLmProvider).not.toHaveBeenCalled();
  });

  it('keeps selection and Step editing in the real graph view, including partial JSON', async () => {
    const state = await graphState();
    vi.spyOn(workspaceModule, 'useWorkflowWorkspace').mockReturnValue(state);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/workflows', component: WorkflowView }] });
    await router.push('/workflows');
    await router.isReady();
    const wrapper = mount({ template: '<router-view />' }, { global: { plugins: [router] } });
    using view = {
      wrapper,
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await flushPromises();
    const inputSelect = wrapper.findAllComponents(SettingsSelect).find(select => select.vm.$attrs['data-testid'] === 'graph-input');
    expect(inputSelect).toBeDefined();
    inputSelect!.vm.$emit('update:modelValue', '["value"]');
    await flushPromises();
    const sourceSelect = wrapper.findAllComponents(SettingsSelect).find(select => select.vm.$attrs['data-testid'] === 'graph-source');
    expect(sourceSelect).toBeDefined();
    sourceSelect!.vm.$emit('update:modelValue', JSON.stringify(['output', 'a', 'value']));
    await flushPromises();
    await wrapper.get('[data-testid="graph-connect-apply"]').trigger('click');
    expect(state.selected.value).toMatchObject({ value: reference({ id: 'a', output: 'value' }) });
    expect(state.mode.value).toBe('graph');
    state.travel({ direction: 'undo' });
    await flushPromises();
    expect(state.selected.value).toMatchObject({ value: literal({ value: 'B' }) });
    await view.wrapper.get('[data-graph-node="a"] [data-testid="graph-select-node"]').trigger('click');
    expect(state.selectedId.value).toBe('a');
    expect(state.mode.value).toBe('graph');
    expect(wrapper.find('[data-testid="workflow-graph"]').exists()).toBe(true);
    state.openPartial();
    await flushPromises();
    state.partialDraft.value = '{"value":{"type":"literal","value":"edited in graph"}}';
    state.applyPartial();
    await flushPromises();
    expect(state.selected.value).toMatchObject({ value: literal({ value: 'edited in graph' }) });
    expect(state.mode.value).toBe('graph');
    wrapper.getComponent(WorkflowGraph).vm.$emit('add', { type: 'value', target: { parentId: undefined, branch: 'root', index: 2 } });
    state.updateName({ name: 'newer edit while label loads' });
    await flushPromises();
    expect(state.definition.value.steps).toHaveLength(2);
    expect(wrapper.find('[data-testid="workflow-graph"]').exists()).toBe(true);
  });
});

async function seededRecoveryRun({ name, owned }: { name: string, owned: boolean }) {
  const store = createWorkflowRunStore({ storageType: 'opfs' });
  const snapshot = await store.create({ workflowId: undefined, definition: { name, steps: [valueStep({ id: 'seed', value: 'never executed by history' })] } });
  if (!owned) {
    await store.release({ id: snapshot.record.id });
  }
  return {
    store,
    snapshot,
    async [Symbol.asyncDispose]() {
      await store.release({ id: snapshot.record.id });
    },
  };
}

describe('Workflow checkpoints and abandoned-run history', () => {
  it('saves completed previews before waiting for input and retains ownership until final save', async () => {
    using files = createWorkflowTestFileSystem();
    const manager = historyFileSystem({ files });
    vi.spyOn(performance, 'now').mockReturnValue(100);
    const state = workspace();
    await adopt({
      workspace: state,
      definition: {
        name: 'Wait at a checkpoint',
        steps: [valueStep({ id: 'first', value: 'durable preview' }), { id: stepId({ raw: 'ask' }), name: 'Input', type: 'request_input', responseType: 'text', prompt: literal({ value: '?' }) }],
      },
    });
    await using pending = runningWorkflow({ state });
    await vi.waitFor(() => expect(state.pending.value?.kind).toBe('text'));
    const store = createWorkflowRunStore({ storageType: 'opfs' });
    const durable = await store.load({ id: state.activeRunId.value! });
    expect(durable.record.status).toBe('running');
    expect(durable.record.entries[0]).toMatchObject({ phase: 'completed', preview: expect.stringContaining('durable preview') });
    expect(durable.record.entries[1]).toMatchObject({ phase: 'running' });
    expect(durable.record.checkpointAt).toBeGreaterThanOrEqual(durable.record.startedAt);
    expect(await store.activity({ previous: durable })).toBe('active');
    state.stop();
    await pending.run;
    const final = await store.load({ id: durable.record.id });
    expect(final.record.status).toBe('cancelled');
    expect(final.record.entries[0]?.preview).toContain('durable preview');
    expect(manager.held.size).toBe(0);
  });

  it('throttles rapid progress writes while persisting all final previews', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    vi.spyOn(performance, 'now').mockReturnValue(100);
    const factory = runStoreModule.createWorkflowRunStore;
    let checkpoints = 0;
    vi.spyOn(runStoreModule, 'createWorkflowRunStore').mockImplementation(args => {
      const store = factory(args);
      return {
        ...store,
        async checkpoint(input) {
          checkpoints++;
          return store.checkpoint(input);
        },
      };
    });
    const state = workspace();
    await adopt({ workspace: state, definition: { name: 'Bounded writes', steps: Array.from({ length: 100 }, (_, index) => valueStep({ id: `v${index}`, value: `${index}` })) } });
    await state.start();
    expect(state.runState.value).toBe('completed');
    expect(checkpoints).toBe(1);
    const durable = await factory({ storageType: 'opfs' }).load({ id: state.activeRunId.value! });
    expect(durable.record.entries).toHaveLength(100);
    expect(durable.record.entries.every(item => item.phase === 'completed')).toBe(true);
    expect(durable.record.entries.at(-1)?.preview).toContain('99');
  });

  it('stops before the next effect if a checkpoint cannot be saved, without replay', async () => {
    using files = createWorkflowTestFileSystem();
    const manager = historyFileSystem({ files });
    const factory = runStoreModule.createWorkflowRunStore;
    vi.spyOn(runStoreModule, 'createWorkflowRunStore').mockImplementation(args => {
      const store = factory(args);
      return {
        ...store,
        checkpoint: async () => {
          throw new Error('checkpoint quota exhausted');
        },
      };
    });
    const state = workspace();
    await adopt({ workspace: state, definition: { name: 'Stop on disk failure', steps: [baseStep({ id: 'never', type: 'text_generation' })] } });
    await state.start();
    expect(state.runState.value).toBe('failed');
    expect(state.error.value).toContain('checkpoint quota exhausted');
    expect(mocks.loadLmProvider).not.toHaveBeenCalled();
    expect(state.pending.value).toBeUndefined();
    const durable = await factory({ storageType: 'opfs' }).load({ id: state.activeRunId.value! });
    expect(durable.record.status).toBe('failed');
    expect(durable.record.error).toContain('checkpoint quota exhausted');
    expect(state.historySavePending.value).toBe(false);
    expect(manager.held.size).toBe(0);
  });

  it('keeps a failed save owned while discard confirmation is pending and blocks concurrent retry', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    const factory = runStoreModule.createWorkflowRunStore;
    let finishes = 0;
    vi.spyOn(runStoreModule, 'createWorkflowRunStore').mockImplementation(args => {
      const store = factory(args);
      return {
        ...store,
        finish: async () => {
          finishes++;
          throw new Error('save unavailable');
        },
      };
    });
    const state = workspace();
    await adopt({ workspace: state, definition: { name: 'Pending decision', steps: [] } });
    await state.start();
    const store = factory({ storageType: 'opfs' });
    const durable = await store.load({ id: state.activeRunId.value! });
    const answer = Promise.withResolvers<boolean>();
    using unblock = {
      [Symbol.dispose]() {
        answer.resolve(false);
      },
    };
    mocks.confirm.mockReturnValue(answer.promise);
    const discarding = state.discardHistorySave();
    await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    await state.retryHistorySave();
    expect(finishes).toBe(1);
    expect(await store.activity({ previous: durable })).toBe('active');
    answer.resolve(false);
    await discarding;
    expect(state.historySavePending.value).toBe(true);
    expect(await store.activity({ previous: durable })).toBe('active');
    void unblock;
  });

  it('shows another owner as active and never enables recovery or deletion for it', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    await using seed = await seededRecoveryRun({ name: 'Other tab', owned: true });
    const state = workspace();
    const { wrapper } = await routedWorkspace({ state, path: `/workflows/runs/${idToRaw({ id: seed.snapshot.record.id })}` });
    await vi.waitFor(() => expect(wrapper.text()).toContain('Active or awaiting history save'));
    expect(wrapper.get('[data-testid="workflow-mark-interrupted"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="workflow-delete-run"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-testid="workflow-mark-interrupted"]').trigger('click');
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect((await seed.store.load({ id: seed.snapshot.record.id })).source).toBe(seed.snapshot.source);
    await seed.store.release({ id: seed.snapshot.record.id });
    await wrapper.get('[data-testid="workflow-history-refresh"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.get('[data-testid="workflow-mark-interrupted"]').attributes('disabled')).toBeUndefined());
    expect((await seed.store.load({ id: seed.snapshot.record.id })).record.status).toBe('running');
  });

  it('marks an abandoned run only after confirmation and does not execute, copy, or restore outputs', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    await using seed = await seededRecoveryRun({ name: 'Abandoned history', owned: false });
    const state = workspace();
    state.updateName({ name: 'Retain this draft' });
    const { wrapper, router } = await routedWorkspace({ state, path: `/workflows/runs/${idToRaw({ id: seed.snapshot.record.id })}` });
    await vi.waitFor(() => expect(wrapper.get('[data-testid="workflow-mark-interrupted"]').attributes('disabled')).toBeUndefined());
    expect(wrapper.get('[data-testid="workflow-checkpoint-time"]').text()).toContain('Last saved progress');
    await wrapper.get('[data-testid="workflow-mark-interrupted"]').trigger('click');
    await flushPromises();
    expect((await seed.store.load({ id: seed.snapshot.record.id })).source).toBe(seed.snapshot.source);
    mocks.confirm.mockResolvedValue(true);
    await wrapper.get('[data-testid="workflow-mark-interrupted"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[data-testid="workflow-interrupted-notice"]').exists()).toBe(true));
    const recovered = await seed.store.load({ id: seed.snapshot.record.id });
    expect(recovered.record.status).toBe('interrupted');
    expect(recovered.record.definition).toEqual(seed.snapshot.record.definition);
    expect(recovered.record.checkpointAt).toBe(seed.snapshot.record.checkpointAt);
    expect(wrapper.text()).toContain('Interruption recorded at');
    expect(wrapper.text()).toContain('not necessarily the last completed effect');
    expect(state.definition.value.name).toBe('Retain this draft');
    expect(state.runState.value).toBe('idle');
    expect(mocks.loadLmProvider).not.toHaveBeenCalled();
    expect(mocks.createTmpDirectory).not.toHaveBeenCalled();
    expect(mocks.executeTool).not.toHaveBeenCalled();
    await router.push('/workflows/runs');
    await vi.waitFor(() => expect(wrapper.get('[data-testid="workflow-history"]').text()).toContain('Interrupted'));
  });

  it('keeps legacy activity unknown instead of offering destructive recovery', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    await using seed = await seededRecoveryRun({ name: 'Legacy history', owned: false });
    const raw: unknown = JSON.parse(seed.snapshot.source);
    if (typeof raw !== 'object' || raw === null || !('ownership' in raw) || !('checkpointAt' in raw)) {
      throw new Error('Invalid owned-history fixture.');
    }
    const { ownership, checkpointAt, ...legacy } = raw;
    expect(ownership).toBe('web_lock');
    expect(checkpointAt).toBeDefined();
    const path = `naidan-storage/experimental/workflows/runs/${idToRaw({ id: seed.snapshot.record.id })}.json`;
    files.setText({ path, text: JSON.stringify(legacy) });
    const state = workspace();
    const { wrapper } = await routedWorkspace({ state, path: `/workflows/runs/${idToRaw({ id: seed.snapshot.record.id })}` });
    await vi.waitFor(() => expect(wrapper.text()).toContain('owner of this run cannot be verified'));
    expect(wrapper.get('[data-testid="workflow-mark-interrupted"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="workflow-delete-run"]').attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-testid="workflow-checkpoint-time"]').exists()).toBe(false);
    expect(files.text({ path })).toBe(JSON.stringify(legacy));
  });

  it('retains readable history when activity probing fails and recovers only after a successful refresh', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    await using seed = await seededRecoveryRun({ name: 'Readable snapshot', owned: false });
    const factory = runStoreModule.createWorkflowRunStore;
    let fail = true;
    vi.spyOn(runStoreModule, 'createWorkflowRunStore').mockImplementation(args => {
      const store = factory(args);
      return { ...store, activity: input => fail ? Promise.reject(new Error('activity check unavailable')) : store.activity(input) };
    });
    const state = workspace();
    const { wrapper } = await routedWorkspace({ state, path: `/workflows/runs/${idToRaw({ id: seed.snapshot.record.id })}` });
    await vi.waitFor(() => expect(wrapper.text()).toContain('activity check unavailable'));
    expect(wrapper.text()).toContain('Readable snapshot');
    expect(wrapper.get('[data-testid="workflow-mark-interrupted"]').attributes('disabled')).toBeDefined();
    fail = false;
    await wrapper.get('[data-testid="workflow-history-refresh"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.get('[data-testid="workflow-mark-interrupted"]').attributes('disabled')).toBeUndefined());
    expect((await seed.store.load({ id: seed.snapshot.record.id })).record.status).toBe('running');
  });

  it('discards a late recovery confirmation after navigating away from its history', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    await using seed = await seededRecoveryRun({ name: 'Old recovery request', owned: false });
    const state = workspace();
    const { wrapper, router } = await routedWorkspace({ state, path: `/workflows/runs/${idToRaw({ id: seed.snapshot.record.id })}` });
    await vi.waitFor(() => expect(wrapper.get('[data-testid="workflow-mark-interrupted"]').attributes('disabled')).toBeUndefined());
    const answer = Promise.withResolvers<boolean>();
    using unblock = {
      [Symbol.dispose]() {
        answer.resolve(false);
      },
    };
    mocks.confirm.mockReturnValue(answer.promise);
    await wrapper.get('[data-testid="workflow-mark-interrupted"]').trigger('click');
    await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    await router.push('/workflows/runs');
    answer.resolve(true);
    await flushPromises();
    expect((await seed.store.load({ id: seed.snapshot.record.id })).source).toBe(seed.snapshot.source);
    expect(router.currentRoute.value.path).toBe('/workflows/runs');
    expect(wrapper.find('[data-testid="workflow-interrupted-notice"]').exists()).toBe(false);
    void unblock;
  });

  it('does not clobber a competing recovery completed while confirmation was open', async () => {
    using files = createWorkflowTestFileSystem();
    const manager = historyFileSystem({ files });
    await using seed = await seededRecoveryRun({ name: 'Concurrent recovery', owned: false });
    const state = workspace();
    const { wrapper } = await routedWorkspace({ state, path: `/workflows/runs/${idToRaw({ id: seed.snapshot.record.id })}` });
    await vi.waitFor(() => expect(wrapper.get('[data-testid="workflow-mark-interrupted"]').attributes('disabled')).toBeUndefined());
    const answer = Promise.withResolvers<boolean>();
    using unblock = {
      [Symbol.dispose]() {
        answer.resolve(false);
      },
    };
    mocks.confirm.mockReturnValue(answer.promise);
    await wrapper.get('[data-testid="workflow-mark-interrupted"]').trigger('click');
    await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    const other = await seed.store.interrupt({ previous: seed.snapshot });
    answer.resolve(true);
    await vi.waitFor(() => expect(wrapper.text()).toContain('history changed'));
    expect((await seed.store.load({ id: seed.snapshot.record.id })).source).toBe(other.source);
    expect(manager.held.size).toBe(0);
    void unblock;
  });

  it('ignores a late activity result after navigation and does not attach it to another view', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    await using seed = await seededRecoveryRun({ name: 'Slow ownership probe', owned: false });
    const factory = runStoreModule.createWorkflowRunStore;
    const gate = Promise.withResolvers<runStoreModule.WorkflowRunActivity>();
    using unblock = {
      [Symbol.dispose]() {
        gate.resolve('unverifiable');
      },
    };
    let requested = false;
    vi.spyOn(runStoreModule, 'createWorkflowRunStore').mockImplementation(args => ({
      ...factory(args),
      activity: async () => {
        requested = true;
        return gate.promise;
      },
    }));
    const state = workspace();
    const { wrapper, router } = await routedWorkspace({ state, path: `/workflows/runs/${idToRaw({ id: seed.snapshot.record.id })}` });
    await vi.waitFor(() => expect(requested).toBe(true));
    await router.push('/workflows/runs');
    gate.resolve('recoverable');
    await flushPromises();
    expect(wrapper.find('[data-testid="workflow-mark-interrupted"]').exists()).toBe(false);
    expect((await seed.store.load({ id: seed.snapshot.record.id })).source).toBe(seed.snapshot.source);
    expect(mocks.confirm).not.toHaveBeenCalled();
    void unblock;
  });
});

describe('Integrated Workflow completion capabilities', () => {
  it('exports a structural template separately from a full backup without mutating the editor', async () => {
    vi.stubGlobal('Blob', NodeBlob);
    const state = workspace();
    await adopt({ workspace: state, definition: { name: 'private-title', steps: [valueStep({ id: 'private-id', value: 'private-content' })] } });
    const before = formatWorkflowDefinition({ definition: state.definition.value });
    await state.exportStructure();
    expect(mocks.downloadBlob).not.toHaveBeenCalled();
    mocks.confirm.mockResolvedValue(true);
    await state.exportStructure();
    const template = mocks.downloadBlob.mock.calls[0]![0];
    expect(template.filename).toBe('workflow-structure.json');
    expect(await template.blob.text()).not.toContain('private');
    expect(formatWorkflowDefinition({ definition: state.definition.value })).toBe(before);
    await state.exportDefinition();
    const backup = mocks.downloadBlob.mock.calls[1]![0];
    expect(backup.filename).toBe('workflow.json');
    expect(await backup.blob.text()).toContain('private-content');
    expect(mocks.loadLmProvider).not.toHaveBeenCalled();
  });

  it('preserves drafts when a chat-copy source becomes stale while discard confirmation is open', async () => {
    const state = workspace();
    state.updateName({ name: 'keep existing work' });
    const gate = Promise.withResolvers<boolean>();
    using completion = { gate, [Symbol.dispose]: () => gate.resolve(false) };
    mocks.confirm.mockImplementation(async () => completion.gate.promise);
    let current = true;
    const imported = state.importDefinition({ next: { name: 'from-chat', steps: [] }, canApply: () => current });
    await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    current = false;
    gate.resolve(true);
    expect(await imported).toBe(false);
    expect(state.definition.value.name).toBe('keep existing work');
    expect(mocks.downloadBlob).not.toHaveBeenCalled();
  });

  it('checkpoints a fixed-choice prompt and rejects a forged answer before resuming', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    const state = workspace();
    const step = baseStep({ type: 'request_input', id: 'choose' });
    if (step.type !== 'request_input') {
      throw new Error('fixture');
    }
    step.choices = { type: 'literal', value: ['Keep', 'Change'] };
    await adopt({ workspace: state, definition: { name: 'choices', steps: [step] } });
    const run = state.start();
    await using running = {
      run,
      async [Symbol.asyncDispose]() {
        state.stop();
        await run;
      },
    };
    await vi.waitFor(() => expect(state.pending.value?.choices).toEqual(['Keep', 'Change']));
    const durable = await createWorkflowRunStore({ storageType: 'opfs' }).load({ id: state.activeRunId.value! });
    expect(durable.record.entries.at(-1)?.phase).toBe('running');
    const token = state.pending.value!.token;
    state.respond({ token, text: 'Other' });
    expect(state.pending.value?.token).toBe(token);
    state.respond({ token, text: 'Keep' });
    await running.run;
    expect(state.runState.value).toBe('completed');
    expect(state.resultSources.value).toHaveLength(1);
    expect(await state.resultSources.value[0]!.load({ signal: new AbortController().signal })).toEqual({ type: 'text', text: '"Keep"' });
  });

  it('uses per-call approval and stored progress for model-selected tools, then preserves the conversation in history', async () => {
    using files = createWorkflowTestFileSystem();
    historyFileSystem({ files });
    const state = workspace();
    const step = baseStep({ type: 'text_generation', id: 'auto' });
    if (step.type !== 'text_generation') {
      throw new Error('fixture');
    }
    step.appendMessages = [{ role: 'user', parts: [{ type: 'text', text: 'Read an article' }] }];
    step.toolConfigs = [{ key: 'builtin.wikipedia', status: 'enabled' }];
    let round = 0;
    const provider: LmProvider = {
      listModels: async () => ['test'],
      async *chat() {
        if (round++ === 0) {
          yield { type: 'tool_call', partId: 'call', index: 0, toolCall: { id: toToolCallId({ raw: 'call' }), type: 'function', function: { name: 'wikipedia_get_page', arguments: '{"lang":"en","pageId":42}' } } };
          yield { type: 'result', result: { type: 'finished', next: 'tool_results' } };
        } else {
          yield {
            type: 'text',
            partId: 'answer',
            index: 0,
            chunks: (async function* () {
              yield 'Final answer';
            })(),
            completeness: Promise.resolve('complete'),
          };
          yield { type: 'result', result: { type: 'finished', next: 'user' } };
        }
      },
    };
    mocks.loadLmProvider.mockResolvedValue(provider);
    mocks.executeTool.mockResolvedValue({ outcome: { status: 'success', content: 'Article content' }, metadata: {} });
    await adopt({ workspace: state, definition: { name: 'agent', steps: [step] } });
    const run = state.start();
    await using running = {
      run,
      async [Symbol.asyncDispose]() {
        state.stop();
        await run;
      },
    };
    await vi.waitFor(() => expect(state.pending.value?.connection).toBeDefined());
    state.respond({ token: state.pending.value!.token, text: 'allow' });
    await vi.waitFor(() => expect(state.pending.value?.prompt).toContain('wikipedia_get_page'));
    expect(mocks.executeTool).not.toHaveBeenCalled();
    const durable = await createWorkflowRunStore({ storageType: 'opfs' }).load({ id: state.activeRunId.value! });
    expect(durable.record.entries[0]?.phase).toBe('running');
    state.respond({ token: state.pending.value!.token, text: 'allow' });
    await running.run;
    expect(state.error.value).toBe('');
    expect(state.runState.value).toBe('completed');
    expect(mocks.executeTool).toHaveBeenCalledTimes(1);
    expect(round).toBe(2);
    const transcript = state.resultSources.value.find(source => source.label.endsWith('/ conversation'))!;
    const view = await transcript.load({ signal: new AbortController().signal });
    expect(view.type).toBe('conversation');
    if (view.type !== 'conversation') {
      throw new Error('fixture');
    }
    expect(view.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(view.messages[2]?.parts).toMatchObject([{ type: 'tool_result', result: { content: { text: 'Article content' } } }]);
    const final = await createWorkflowRunStore({ storageType: 'opfs' }).load({ id: state.activeRunId.value! });
    expect(final.record.status).toBe('completed');
  });
});
