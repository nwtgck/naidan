import { beforeEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { MessageNode } from '@/01-models/types';
import { toChatId, toMessageId } from '@/01-models/ids';
import { resolveChatSettings } from '@/logic/chat-settings-resolver';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { WorkflowDefinition } from '@/01-models/workflow';
import WorkflowFromChatButton from './WorkflowFromChatButton.vue';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  push: vi.fn(),
  read: vi.fn(),
  adopt: vi.fn<({ next, canApply }: { next: WorkflowDefinition, canApply: () => boolean }) => Promise<boolean>>(),
}));
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: mocks.confirm }) }));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/00-storage/service', () => ({ storageService: { getFile: mocks.read } }));
vi.mock('@/features/workflow/composables/use-workflow-workspace', () => ({ useWorkflowWorkspace: () => ({ importDefinition: mocks.adopt }) }));

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.confirm.mockResolvedValue(true);
  mocks.adopt.mockImplementation(async ({ canApply }) => canApply());
});

function fixture() {
  const messages: MessageNode[] = [{ id: toMessageId({ raw: 'original' }), role: 'assistant', parts: [{ type: 'text', text: 'answer', completeness: 'complete' }], replies: { items: [] }, createdAt: 0, modelId: undefined, lmParameters: undefined, interruption: undefined }];
  const settings = resolveChatSettings({
    chat: { id: toChatId({ raw: 'source' }), title: 'Source', createdAt: 0, updatedAt: 0, debugEnabled: false, root: { items: messages } },
    groups: [],
    globalSettings: { endpoint: { type: 'ollama', url: 'http://local' }, defaultModelId: 'selected', systemPrompt: 'effective system' },
  });
  const wrapper = mount(WorkflowFromChatButton, { props: { messages, settings, title: 'Source', disabled: false } });
  return { wrapper, messages, settings, [Symbol.dispose]: () => wrapper.unmount() };
}

async function settle() {
  await flushPromises();
  await vi.dynamicImportSettled();
  await flushPromises();
}

it('copies only on consent and captures effective settings without model or tool execution', async () => {
  using test = fixture();
  expect(mocks.adopt).not.toHaveBeenCalled();
  await test.wrapper.get('button').trigger('click');
  await settle();
  expect(mocks.adopt).toHaveBeenCalledTimes(1);
  const definition = mocks.adopt.mock.calls[0]![0].next;
  const step = definition.steps[1];
  expect(step).toMatchObject({ type: 'text_generation', target: { type: 'model', modelId: 'selected' }, toolConfigs: [] });
  expect(JSON.stringify(definition)).toContain('effective system');
  expect(JSON.stringify(definition)).toContain('answer');
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.push).toHaveBeenCalledExactlyOnceWith('/workflows');
});

it('does nothing after declined consent', async () => {
  mocks.confirm.mockResolvedValue(false);
  using test = fixture();
  await test.wrapper.get('button').trigger('click');
  await settle();
  expect(mocks.adopt).not.toHaveBeenCalled();
  expect(mocks.push).not.toHaveBeenCalled();
});

it.each(['messages', 'disabled', 'unmount'] as const)('rejects late consent after %s changes', async change => {
  const gate = Promise.withResolvers<boolean>();
  using completion = { gate, [Symbol.dispose]: () => gate.resolve(false) };
  mocks.confirm.mockReturnValue(completion.gate.promise);
  using test = fixture();
  await test.wrapper.get('button').trigger('click');
  await flushPromises();
  if (change === 'messages') {
    await test.wrapper.setProps({ messages: [] });
  } else if (change === 'disabled') {
    await test.wrapper.setProps({ disabled: true });
  } else {
    test.wrapper.unmount();
  }
  gate.resolve(true);
  await settle();
  expect(mocks.adopt).not.toHaveBeenCalled();
});

it('rechecks disabled state inside a delayed destination-discard confirmation', async () => {
  const gate = Promise.withResolvers<void>();
  using completion = { gate, [Symbol.dispose]: () => gate.resolve() };
  mocks.adopt.mockImplementation(async ({ canApply }) => {
    await completion.gate.promise;
    return canApply();
  });
  using test = fixture();
  await test.wrapper.get('button').trigger('click');
  await settle();
  expect(mocks.adopt).toHaveBeenCalledTimes(1);
  await test.wrapper.setProps({ disabled: true });
  gate.resolve();
  await settle();
  expect(mocks.push).not.toHaveBeenCalled();
});

export const TEST_ONLY = {
};
