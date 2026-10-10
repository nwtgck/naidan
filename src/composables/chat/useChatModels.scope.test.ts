import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, effectScope, h, ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { toChatId } from '@/01-models/ids';
import { useChatModels, type ChatModelsAdapter } from './useChatModels';
import { provideChatViewScope } from './ui/chat-view-scope';
import { availableModels } from './global/chat-core-singletons';

const mocks = vi.hoisted(() => ({ chat: vi.fn(), endpoint: vi.fn(), global: vi.fn() }));
vi.mock('./chat-model-fetch', () => ({ fetchModelsForChat: mocks.chat, fetchModelsForEndpoint: mocks.endpoint, fetchModelsForGlobalEndpoint: mocks.global }));
vi.mock('./global/chat-core-singletons', async () => {
  const { ref } = await import('vue');
  return { availableModels: ref(['global-model']), fetchingModels: ref(false) };
});
const chatA = toChatId({ raw: 'chat-aa' }), chatB = toChatId({ raw: 'chat-bb' });
const scopes: ReturnType<typeof effectScope>[] = [];
const wrappers: VueWrapper[] = [];

function open({ chatId }: { chatId: typeof chatA }) {
  const scope = effectScope(); scopes.push(scope);
  const current = ref(chatId);
  const adapter = scope.run(() => useChatModels({ scope: computed(() => current.value) }))!;
  return { current, adapter, scope };
}

beforeEach(() => {
  vi.resetAllMocks(); availableModels.value = ['global-model'];
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount(); for (const scope of scopes.splice(0)) scope.stop();
});

describe('model choices for an embedded ChatPane', () => {
  it('keeps independent lists and loading states for two displayed chats', async () => {
    const a = open({ chatId: chatA }), b = open({ chatId: chatB });
    const pendingA = Promise.withResolvers<string[]>(), pendingB = Promise.withResolvers<string[]>();
    mocks.chat.mockReturnValueOnce(pendingA.promise).mockReturnValueOnce(pendingB.promise);
    const first = a.adapter.fetchForChat({ chatId: chatA }); const second = b.adapter.fetchForChat({ chatId: chatB });
    expect(a.adapter.fetchingModels.value).toBe(true); expect(b.adapter.fetchingModels.value).toBe(true);
    pendingB.resolve(['b-model']); await second;
    expect(a.adapter.availableModels.value).toEqual([]); expect(b.adapter.availableModels.value).toEqual(['b-model']);
    expect(b.adapter.fetchingModels.value).toBe(false); expect(a.adapter.fetchingModels.value).toBe(true);
    pendingA.resolve(['a-model']); await first;
    expect(a.adapter.availableModels.value).toEqual(['a-model']); expect(availableModels.value).toEqual(['global-model']);
  });

  it('rejects late responses after changing the displayed chat or starting a newer request', async () => {
    const view = open({ chatId: chatA }); const pending = Promise.withResolvers<string[]>();
    mocks.chat.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(['current']);
    const old = view.adapter.fetchForChat({ chatId: chatA }); view.current.value = chatB;
    await view.adapter.fetchForChat({ chatId: chatB }); pending.resolve(['old']); await old;
    expect(view.adapter.availableModels.value).toEqual(['current']);
    const slow = Promise.withResolvers<string[]>(); mocks.chat.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(['newer']);
    const older = view.adapter.fetchForChat({ chatId: chatB }); await view.adapter.fetchForChat({ chatId: chatB });
    slow.resolve(['stale same chat']); await older; expect(view.adapter.availableModels.value).toEqual(['newer']);
  });

  it('does not publish to another chat or a disposed view and clears loading after errors', async () => {
    const view = open({ chatId: chatA }); mocks.chat.mockResolvedValueOnce(['other']);
    await view.adapter.fetchForChat({ chatId: chatB }); expect(view.adapter.availableModels.value).toEqual([]);
    mocks.chat.mockRejectedValueOnce(new Error('offline'));
    await expect(view.adapter.fetchForChat({ chatId: chatA })).rejects.toThrow('offline');
    expect(view.adapter.fetchingModels.value).toBe(false);
    const pending = Promise.withResolvers<string[]>(); mocks.chat.mockReturnValueOnce(pending.promise);
    const task = view.adapter.fetchForChat({ chatId: chatA }); view.scope.stop(); pending.resolve(['disposed']); await task;
    expect(view.adapter.availableModels.value).toEqual([]);
  });

  it('lets existing descendants use the provided identity without new component props', async () => {
    let adapter: ChatModelsAdapter | undefined;
    const child = defineComponent({
      setup() {
        adapter = useChatModels(); return () => h('div');
      },
    });
    const parent = defineComponent({
      setup() {
        provideChatViewScope({ chatId: ref(chatB) }); return () => h(child);
      },
    });
    wrappers.push(mount(parent)); mocks.chat.mockResolvedValueOnce(['embedded']);
    await adapter!.fetchForChat({ chatId: chatB });
    expect(adapter!.availableModels.value).toEqual(['embedded']); expect(availableModels.value).toEqual(['global-model']);
  });

  it('preserves the global facade for callers without a ChatPane scope', () => {
    const adapter = useChatModels(); expect(adapter.availableModels).toBe(availableModels);
  });
});
