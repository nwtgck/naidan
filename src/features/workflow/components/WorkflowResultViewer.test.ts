import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { toChatId, toMessageId } from '@/01-models/ids';
import type { WorkflowResultSource, WorkflowResultView } from '@/features/workflow/logic/result-view';
import WorkflowResultViewer from './WorkflowResultViewer.vue';
import WorkflowLiveImage from './WorkflowLiveImage.vue';
import WorkflowResultGallery from './WorkflowResultGallery.vue';
import type { PreviewFrame } from '@/features/stable-diffusion-cpp-browser/types';

const mocks = vi.hoisted(() => ({ confirm: vi.fn(), create: vi.fn(), push: vi.fn(), url: vi.fn(), revoke: vi.fn() }));
const settings = ref({ endpoint: { type: 'ollama', url: 'http://current' }, defaultModelId: 'selected', lmParameters: {} });
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings }) }));
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: mocks.confirm }) }));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/composables/chat/ui/useChatLifecycle', () => ({ useChatLifecycle: () => ({ createChatFromHistory: mocks.create }) }));

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.confirm.mockResolvedValue(true);
  mocks.create.mockResolvedValue({ id: toChatId({ raw: 'new' }) });
  let count = 0;
  mocks.url.mockImplementation(() => `blob:test-${++count}`);
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = mocks.url;
    static override revokeObjectURL = mocks.revoke;
  });
});

afterEach(() => vi.unstubAllGlobals());

function viewer({ source }: { source: WorkflowResultSource }) {
  const wrapper = mount(WorkflowResultViewer, { props: { source } });
  return { wrapper, [Symbol.dispose]: () => wrapper.unmount() };
}

const source = ({ view }: { view: WorkflowResultView }): WorkflowResultSource => ({ id: 'source', label: 'Result', load: vi.fn(async () => view) });

const conversation = (): WorkflowResultView => ({ type: 'conversation', messages: [{ id: toMessageId({ raw: 'old' }), role: 'assistant', parts: [{ type: 'reasoning', text: 'reasoning', completeness: 'complete' }, { type: 'text', text: '<script>not executable</script>', completeness: 'complete' }] }] });

it('loads images only on request and revokes each object URL on close or unmount', async () => {
  const value = source({ view: { type: 'image', blob: new Blob(['png'], { type: 'image/png' }) } });
  using test = viewer({ source: value });
  expect(value.load).not.toHaveBeenCalled();
  await test.wrapper.get('button').trigger('click');
  await flushPromises();
  expect(test.wrapper.get('img').attributes('src')).toBe('blob:test-1');
  await test.wrapper.get('button').trigger('click');
  expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith('blob:test-1');
  await test.wrapper.get('button').trigger('click');
  await flushPromises();
  test.wrapper.unmount();
  expect(mocks.revoke.mock.calls.flat()).toEqual(['blob:test-1', 'blob:test-2']);
});

it.each(['source', 'unmount'])('aborts a pending load on %s and ignores its late result', async change => {
  const gate = Promise.withResolvers<WorkflowResultView>();
  using completion = { gate, [Symbol.dispose]: () => gate.resolve({ type: 'text', text: '' }) };
  const load = vi.fn(async () => completion.gate.promise);
  using test = viewer({ source: { id: 'old', label: 'old', load } });
  await test.wrapper.get('button').trigger('click');
  if (change === 'source') {
    await test.wrapper.setProps({ source: source({ view: { type: 'text', text: 'new' } }) });
  } else {
    test.wrapper.unmount();
  }
  gate.resolve({ type: 'image', blob: new Blob(['late']) });
  await flushPromises();
  expect(mocks.url).not.toHaveBeenCalled();
});

it('shows recoverable load errors and does not render user text as markup', async () => {
  const value = source({ view: { type: 'text', text: '<img src=x onerror=alert(1)>' } });
  vi.mocked(value.load).mockRejectedValueOnce(new Error('unavailable'));
  using test = viewer({ source: value });
  await test.wrapper.get('button').trigger('click');
  await flushPromises();
  expect(test.wrapper.get('[role="alert"]').text()).toBe('unavailable');
  await test.wrapper.get('button').trigger('click');
  await flushPromises();
  expect(test.wrapper.find('img').exists()).toBe(false);
  expect(test.wrapper.get('pre').text()).toBe('<img src=x onerror=alert(1)>');
});

it('does not autoplay or preload stored audio', async () => {
  using test = viewer({ source: source({ view: { type: 'audio', blob: new Blob(['wave'], { type: 'audio/wav' }) } }) });
  await test.wrapper.get('button').trigger('click');
  await flushPromises();
  expect(test.wrapper.get('audio').attributes()).toMatchObject({ controls: '', preload: 'none' });
  expect(test.wrapper.get('audio').attributes('autoplay')).toBeUndefined();
});

it('copies a conversation only after explicit confirmation and uses a new chat', async () => {
  using test = viewer({ source: source({ view: conversation() }) });
  await test.wrapper.get('button').trigger('click');
  await flushPromises();
  expect(test.wrapper.find('script').exists()).toBe(false);
  expect(test.wrapper.text()).toContain('reasoning');
  expect(mocks.create).not.toHaveBeenCalled();
  const copy = test.wrapper.findAll('button').find(button => button.text() === 'Copy to a new chat')!;
  await copy.trigger('click');
  await flushPromises();
  await vi.dynamicImportSettled();
  await flushPromises();
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'selected', endpoint: { type: 'ollama', url: 'http://current' } }));
  expect(mocks.push).toHaveBeenCalledWith('/chat/new');
});

it('does not apply a late copy confirmation after the source changes', async () => {
  using test = viewer({ source: source({ view: conversation() }) });
  await test.wrapper.get('button').trigger('click');
  await flushPromises();
  const gate = Promise.withResolvers<boolean>();
  using completion = { gate, [Symbol.dispose]: () => gate.resolve(false) };
  mocks.confirm.mockImplementation(async () => completion.gate.promise);
  await test.wrapper.findAll('button').find(button => button.text() === 'Copy to a new chat')!.trigger('click');
  await flushPromises();
  await test.wrapper.setProps({ source: source({ view: { type: 'text', text: 'new' } }) });
  gate.resolve(true);
  await flushPromises();
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.push).not.toHaveBeenCalled();
});

it('reports object URL creation failure without keeping an undisplayable view', async () => {
  mocks.url.mockImplementationOnce(() => {
    throw new Error('URL unavailable');
  });
  using test = viewer({ source: source({ view: { type: 'image', blob: new Blob(['png']) } }) });
  await test.wrapper.get('button').trigger('click');
  await flushPromises();
  expect(test.wrapper.get('[role="alert"]').text()).toBe('URL unavailable');
  expect(test.wrapper.find('img').exists()).toBe(false);
});

it('releases preview URLs on frame replacement and tolerates optional preview failure', async () => {
  const frame: PreviewFrame = { type: 'naidan-image-preview-v1', runId: 1, revision: 0, step: 1, steps: 3, mode: 'projection', width: 128, height: 128, png: new Blob(['png'], { type: 'image/png' }) };
  const wrapper = mount(WorkflowLiveImage, { props: { frame } });
  using test = { wrapper, [Symbol.dispose]: () => wrapper.unmount() };
  expect(test.wrapper.get('img').attributes('src')).toBe('blob:test-1');
  await test.wrapper.setProps({ frame: { ...frame, step: 2 } });
  expect(mocks.revoke).toHaveBeenCalledWith('blob:test-1');
  mocks.url.mockImplementationOnce(() => {
    throw new Error('unavailable');
  });
  await test.wrapper.setProps({ frame: { ...frame, step: 3 } });
  expect(test.wrapper.find('img').exists()).toBe(false);
  expect(mocks.revoke).toHaveBeenCalledWith('blob:test-2');
});

it('paginates result sources without loading any bytes merely by showing the gallery', async () => {
  const load = vi.fn(async (): Promise<WorkflowResultView> => ({ type: 'text', text: 'x' }));
  const wrapper = mount(WorkflowResultGallery, { props: { sources: Array.from({ length: 25 }, (_, index) => ({ id: String(index), label: `Result ${index}`, load })) } });
  using test = { wrapper, [Symbol.dispose]: () => wrapper.unmount() };
  expect(test.wrapper.findAll('[data-testid="workflow-result-viewer"]')).toHaveLength(20);
  await test.wrapper.findAll('button').find(button => button.text() === 'Show more results')!.trigger('click');
  expect(test.wrapper.findAll('[data-testid="workflow-result-viewer"]')).toHaveLength(25);
  expect(load).not.toHaveBeenCalled();
});

export const TEST_ONLY = {
};
