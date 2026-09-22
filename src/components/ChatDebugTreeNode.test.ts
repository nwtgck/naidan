import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ChatDebugTreeNode from './ChatDebugTreeNode.vue';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import type { MessageNode, UserMessageNode } from '@/01-models/types';
import { toAttachmentId, toBinaryObjectId, toMessageId, toToolCallId } from '@/01-models/ids';

const { getFile } = vi.hoisted(() => ({ getFile: vi.fn() }));
vi.mock('@/00-storage/service', () => ({ storageService: { getFile } }));
vi.mock('@/composables/useGlobalEvents', () => ({ useGlobalEvents: () => ({ addErrorEvent: vi.fn() }) }));
const wrappers: ReturnType<typeof mount>[] = [];
function render({ node }: { node: MessageNode }) {
  const wrapper = mount(ChatDebugTreeNode, { props: { node, activeIds: new Set([node.id]), highlight: false, mode: 'active' } });
  wrappers.push(wrapper); return wrapper;
}
function user({ status }: { status: 'memory' | 'persisted' }): UserMessageNode {
  const common = { id: toAttachmentId({ raw: 'file' }), binaryObjectId: toBinaryObjectId({ raw: 'binary' }), mimeType: 'image/png', originalName: 'image.png', size: 1, uploadedAt: 0 };
  return { id: toMessageId({ raw: 'u' }), role: 'user', createdAt: 0, modelId: undefined, lmParameters: undefined, replies: { items: [] },
    parts: [{ type: 'attachment', attachment: status === 'memory' ? { ...common, status, blob: new Blob(['image'], { type: 'image/png' }) } : { ...common, status } }] };
}
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' }); vi.clearAllMocks();
  getFile.mockResolvedValue(new Blob(['image']));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:debug');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(() => {
  wrappers.splice(0).forEach(w => w.unmount()); vi.restoreAllMocks();
});
it('renders raw body and reasoning in part order including explicit empty parts', async () => {
  const node: MessageNode = { id: toMessageId({ raw: 'a' }), role: 'assistant', createdAt: 0, modelId: undefined, lmParameters: undefined,
    interruption: { type: 'error', message: '保存済みの日本語エラー' }, replies: { items: [] }, parts: [
      { type: 'reasoning', text: '  考える\n', completeness: 'complete' },
      { type: 'text', text: '', completeness: 'complete' },
      { type: 'text', text: '<think>literal</think>  🙂\n', completeness: 'partial' },
      { type: 'tool_call', toolCall: { id: toToolCallId({ raw: 'c' }), type: 'function', function: { name: 'f', arguments: '{ "x": 1 }' } } },
    ] };
  const snapshot = structuredClone(node); const w = render({ node });
  expect(w.findAll('[data-testid="debug-part"]').map(part => part.attributes('data-part-type'))).toEqual(['reasoning', 'text', 'text', 'tool_call']);
  expect(w.findAll('[data-testid="debug-part-text"]').map(p => p.element.textContent)).toEqual(['  考える\n', '', '<think>literal</think>  🙂\n']);
  expect(w.get('[data-testid="debug-interruption"]').text()).toContain('保存済みの日本語エラー');
  expect(w.text()).toContain('1970-01-01T00:00:00.000Z');
  await w.find('[data-testid="copy-content-btn"]').trigger('click');
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith('<think>literal</think>  🙂\n');
  expect(node).toEqual(snapshot);
});
it('renders tool results without flattening them into body text', () => {
  const w = render({ node: { id: toMessageId({ raw: 't' }), role: 'tool', createdAt: 0, modelId: undefined, lmParameters: undefined, replies: { items: [] },
    parts: [{ type: 'tool_result', result: { toolCallId: toToolCallId({ raw: 'c' }), status: 'success', content: { type: 'text', text: '<think>result</think>' } } }] } });
  expect(w.get('[data-testid="debug-part"][data-part-type="tool_result"]').text()).toContain('<think>result</think>');
  expect(w.find('[data-testid="copy-content-btn"]').exists()).toBe(false);
});
it('uses a memory Blob and releases the thumbnail when the part is removed', async () => {
  const node = user({ status: 'memory' }); const w = render({ node }); await flushPromises();
  expect(getFile).not.toHaveBeenCalled(); expect(URL.createObjectURL).toHaveBeenCalledWith(node.parts[0]?.type === 'attachment' && node.parts[0].attachment.status === 'memory' ? node.parts[0].attachment.blob : undefined);
  expect(w.find('img').attributes('src')).toBe('blob:debug');
  await w.setProps({ node: { ...node, parts: [] } }); await flushPromises();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:debug');
});
it('does not publish thumbnails that arrive after removal or unmount', async () => {
  let resolve: (value: Blob) => void = () => {
    throw new Error('not started');
  };
  getFile.mockImplementation(() => new Promise<Blob>(done => {
    resolve = done;
  }));
  const node = user({ status: 'persisted' }); const w = render({ node });
  await w.setProps({ node: { ...node, parts: [] } }); resolve(new Blob(['late'])); await flushPromises();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  await w.setProps({ node }); w.unmount(); wrappers.splice(wrappers.indexOf(w), 1);
  resolve(new Blob(['late'])); await flushPromises(); expect(URL.createObjectURL).not.toHaveBeenCalled();
});
