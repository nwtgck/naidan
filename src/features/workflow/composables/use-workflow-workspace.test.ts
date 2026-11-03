import { File as NodeFile } from 'node:buffer';
import { ref } from 'vue';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { createRouter, createMemoryHistory } from 'vue-router';
import WorkflowView from '@/features/workflow/WorkflowView.vue';
import * as workspaceModule from './use-workflow-workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { createWorkflowTestFileSystem } from '@/00-storage/service/workflow-files.test-support';
import { TEST_ONLY, type WorkflowWorkspace } from './use-workflow-workspace';
import { stepId } from '@/features/workflow/logic/workflow.test-support';
import { toWorkflowId } from '@/01-models/ids';
import type { WorkflowDefinition } from '@/01-models/workflow';

const mocks = vi.hoisted(() => ({ confirm: vi.fn(), prompt: vi.fn(), save: vi.fn(), list: vi.fn(), load: vi.fn(), remove: vi.fn(), createTmpDirectory: vi.fn(), downloadFile: vi.fn(), downloadBlob: vi.fn(), openFileExplorer: vi.fn(), loadLmProvider: vi.fn() }));
const settings = ref({ storageType: 'opfs', endpoint: { type: 'ollama', url: 'http://localhost:11434' }, defaultModelId: 'test', lmParameters: {}, experimental: undefined });
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings }) }));
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: mocks.confirm }) }));
vi.mock('@/composables/usePrompt', () => ({ usePrompt: () => ({ showPrompt: mocks.prompt }) }));
vi.mock('@/00-storage/service/workflow-document', () => ({ createWorkflowDocumentStore: () => ({ save: mocks.save, load: mocks.load, remove: mocks.remove, list: mocks.list }) }));
vi.mock('@/00-storage/service', () => ({ storageService: { getCurrentType: () => settings.value.storageType, async *listVolumes() {} } }));
vi.mock('@/features/lm/providerFactory', () => ({ loadLmProvider: mocks.loadLmProvider }));
vi.mock('@/logic/opfs-tmp-manager', () => ({ getOPFSTmpManager: () => ({ createTmpDirectory: mocks.createTmpDirectory }) }));
vi.mock('@/features/file-explorer/composables/useFileExplorerModal', () => ({ useFileExplorerModal: () => ({ openFileExplorer: mocks.openFileExplorer }) }));
vi.mock('@/utils/stream-download', () => ({ downloadFile: mocks.downloadFile, downloadBlob: mocks.downloadBlob }));

const workspaces: WorkflowWorkspace[] = [];
const wrappers: VueWrapper[] = [];

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
  workspace.jsonDraft.value = JSON.stringify(definition);
  workspace.applyJson();
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
