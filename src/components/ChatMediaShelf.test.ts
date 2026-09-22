import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ChatMediaShelf from './ChatMediaShelf.vue';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { toAttachmentId, toBinaryObjectId, toChatId, toMessageId } from '@/01-models/ids';
import type { UserMessageNode } from '@/01-models/types';

const { getFile, openPreview, detectSupport } = vi.hoisted(() => ({ getFile: vi.fn(), openPreview: vi.fn(), detectSupport: vi.fn() }));
vi.mock('@/00-storage/service', () => ({ storageService: { getFile } }));
vi.mock('@/composables/useBinaryActions', () => ({ useBinaryActions: () => ({ downloadBinaryObject: vi.fn() }) }));
vi.mock('@/composables/useImagePreview', () => ({ useImagePreview: () => ({ openPreview }) }));
vi.mock('@/composables/useGlobalEvents', () => ({ useGlobalEvents: () => ({ addErrorEvent: vi.fn() }) }));
vi.mock('./ImageDownloadHydrator', () => ({ ImageDownloadHydrator: { detectSupport, download: vi.fn() } }));

function message({ blob }: { blob: Blob | undefined }): UserMessageNode {
  const common = { id: toAttachmentId({ raw: 'image' }), binaryObjectId: toBinaryObjectId({ raw: 'binary' }),
    originalName: 'user.png', mimeType: 'image/png', size: 10, uploadedAt: 7 };
  return { id: toMessageId({ raw: 'user' }), role: 'user', createdAt: 7, modelId: undefined, lmParameters: undefined,
    parts: [
      { type: 'text', text: '  Uploaded image  ', completeness: 'complete' },
      { type: 'attachment', attachment: blob === undefined ? { ...common, status: 'persisted' } : { ...common, status: 'memory', blob } },
    ], replies: { items: [] } };
}

let observed: Element[];
let intersect: (({ element }: { element: Element }) => void) | undefined;
const wrappers: ReturnType<typeof mount>[] = [];
async function createShelf({ messages }: { messages: UserMessageNode[] }) {
  const wrapper = mount(ChatMediaShelf, { props: { chatId: toChatId({ raw: 'chat' }), messages }, global: { stubs: { ImageDownloadButton: true } } });
  wrappers.push(wrapper); await flushPromises(); return wrapper;
}

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  vi.clearAllMocks(); observed = []; intersect = undefined;
  getFile.mockResolvedValue(new Blob(['image'], { type: 'image/png' })); detectSupport.mockResolvedValue(true);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:shelf-image');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  // The browser invokes this constructor with its standard positional callback.
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: (entries: { isIntersecting: boolean; target: Element }[]) => void) {
      intersect = ({ element }) => callback([{ isIntersecting: true, target: element }]);
    }
    observe(element: Element) {
      observed.push(element);
    }
    disconnect() {}
  });
});
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount());
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('ChatMediaShelf with parts', () => {
  it('shows an attachment and preserves preview and jump behavior', async () => {
    const value = message({ blob: undefined });
    const wrapper = await createShelf({ messages: [value] });
    const media = wrapper.findAll('.media-item-trigger');
    expect(media).toHaveLength(1); expect(media[0]?.attributes('data-id')).toBe('binary');
    await media[0]!.trigger('click');
    expect(openPreview).toHaveBeenCalledWith(expect.objectContaining({ initialId: toBinaryObjectId({ raw: 'binary' }) }));
    await wrapper.find('button[title="Jump to this message in chat"]').trigger('click');
    expect(wrapper.emitted('jump-to-message')?.[0]).toEqual([value.id]);
  });

  it('uses the local memory Blob without a persisted-file read', async () => {
    const blob = new Blob(['unsaved'], { type: 'image/png' });
    const wrapper = await createShelf({ messages: [message({ blob })] });
    expect(observed).toHaveLength(1); intersect?.({ element: observed[0]! }); await flushPromises();
    expect(getFile).not.toHaveBeenCalled(); expect(detectSupport).toHaveBeenCalledWith({ blob });
    expect(wrapper.find('img').attributes('src')).toBe('blob:shelf-image');
  });

  it('revokes removed images and does not retain a late read after unmount', async () => {
    const wrapper = await createShelf({ messages: [message({ blob: undefined })] });
    intersect?.({ element: observed[0]! }); await flushPromises();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    await wrapper.setProps({ messages: [] }); await flushPromises();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:shelf-image');
    let resolveFile: (value: Blob) => void = () => {
      throw new Error('Read not started');
    };
    getFile.mockImplementation(() => new Promise<Blob>(resolve => {
      resolveFile = resolve;
    }));
    await wrapper.setProps({ messages: [message({ blob: undefined })] }); await flushPromises();
    intersect?.({ element: observed.at(-1)! });
    wrapper.unmount(); wrappers.splice(wrappers.indexOf(wrapper), 1);
    resolveFile(new Blob(['late'])); await flushPromises();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });
});
