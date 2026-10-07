import { describe, expect, it, vi } from 'vitest';
import { idToRaw, toChatId, toImageGenerationBindingId, toImageGenerationDraftRevisionId, toImageGenerationSessionId, toImageGenerationStoreId } from '@/01-models/ids';
import type { ApprovalEnsureResult, EnsureApproval } from '@/01-models/tool-approval';
import type { Tool } from '@/01-models/tool';
import { createImageGenerationAssistantTools } from './assistant-tools';
import { getImageGenerationToolsForChat, registerImageGenerationAssistant } from './assistant-registry';
import type { ImageGenerationPromptEdit, ImageGenerationPromptTarget } from './prompt-access';

function harness() {
  const initial: ImageGenerationPromptTarget = { storeId: toImageGenerationStoreId({ raw: 'store-aa' }), sessionId: toImageGenerationSessionId({ raw: 'session-aa' }),
    bindingId: toImageGenerationBindingId({ raw: 'binding-aa' }), revision: toImageGenerationDraftRevisionId({ raw: 'revision-aa' }), chatId: toChatId({ raw: 'chat-aa' }), prompt: '日本語で入力', negativePrompt: '' };
  let target: ImageGenerationPromptTarget | undefined = { ...initial };
  const binding = new AbortController(), signal = new AbortController();
  const ensureApproval = vi.fn<EnsureApproval>().mockResolvedValue({ status: 'approved' });
  const commit = vi.fn(({ edit }: { expected: ImageGenerationPromptTarget, edit: ImageGenerationPromptEdit }): 'applied' | 'conflict' => {
    if (!target) return 'conflict';
    target = { ...target, [edit.field]: edit.value, revision: toImageGenerationDraftRevisionId({ raw: 'revision-new' }) }; return 'applied';
  });
  const create = () => createImageGenerationAssistantTools({ chatId: initial.chatId, bindingSignal: binding.signal, readTarget: () => target,
    readContext: () => ({ sessionTitle: '日本語セッション', model: 'Custom model', width: 512, height: 768, steps: 8, guidance: 1, count: 4 }), commit });
  const tools = create();
  const read = tools.find(tool => tool.name === 'image_generation_get_context'), write = tools.find(tool => tool.name === 'image_generation_set_prompt');
  if (!read || !write) throw new Error('Expected prompt tools');
  const context = { signal: signal.signal, approvalContext: { chatId: initial.chatId, ensureApproval } };
  const args = { expectedRevision: idToRaw({ id: initial.revision }), field: 'prompt', value: 'An English prompt' };
  return { initial, create, tools, read, write, context, args, commit, ensureApproval, binding, signal,
    replace({ value }: { value: ImageGenerationPromptTarget | undefined }) {
      target = value;
    } };
}

describe('ephemeral Workspace tool protocol', () => {
  it('exposes only context reading and permission-checked prompt editing', async () => {
    const h = harness();
    expect(h.tools.map(tool => tool.name)).toEqual(['image_generation_get_context', 'image_generation_set_prompt']);
    const outcome = await h.read.execute({ ...h.context, args: {} });
    expect(outcome.status).toBe('success');
    if (outcome.status !== 'success') throw new Error('Read failed');
    expect(JSON.parse(outcome.content)).toMatchObject({ prompt: '日本語で入力', model: 'Custom model', revision: 'revision-aa', count: 4 });
    expect(h.ensureApproval).not.toHaveBeenCalled();
    expect(await h.write.execute({ ...h.context, args: h.args })).toMatchObject({ status: 'success' });
    expect(h.ensureApproval).toHaveBeenCalledWith(expect.objectContaining({ chatId: h.initial.chatId, action: expect.objectContaining({ id: 'tool.image_generation.set_prompt' }),
      preview: { type: 'image_generation_prompt', field: 'prompt', before: '日本語で入力', after: 'An English prompt' } }));
    expect(h.commit).toHaveBeenCalledOnce();
  });
  it.each(['wrong revision', 'wrong chat', 'missing chat', 'unknown field', 'legacy protocol', 'detached', 'turn aborted'])('rejects %s without permission or mutation', async cause => {
    const h = harness();
    let args: unknown = h.args, approvalContext = h.context.approvalContext as Parameters<Tool['execute']>[0]['approvalContext'];
    switch (cause) {
    case 'wrong revision': args = { ...h.args, expectedRevision: 'outdated' }; break;
    case 'wrong chat': approvalContext = { ...h.context.approvalContext, chatId: toChatId({ raw: 'another-chat' }) }; break;
    case 'missing chat': approvalContext = undefined; break;
    case 'unknown field': args = { ...h.args, generate: true }; break;
    case 'legacy protocol': args = { prompt: 'old shape' }; break;
    case 'detached': h.binding.abort(); break;
    case 'turn aborted': h.signal.abort(); break;
    }
    expect(await h.write.execute({ ...h.context, approvalContext, args })).toMatchObject({ status: 'error' });
    expect(h.ensureApproval).not.toHaveBeenCalled(); expect(h.commit).not.toHaveBeenCalled();
  });
  it('denial remains a normal transcript error and does not retry the edit', async () => {
    const h = harness(); h.ensureApproval.mockResolvedValue({ status: 'denied' });
    expect(await h.write.execute({ ...h.context, args: h.args })).toMatchObject({ status: 'error', code: 'execution_failed' });
    expect(h.commit).not.toHaveBeenCalled(); expect(h.ensureApproval).toHaveBeenCalledOnce();
  });
  it('rejects a remembered grant after the context changed while awaiting approval', async () => {
    const h = harness(), permission = Promise.withResolvers<ApprovalEnsureResult>();
    h.ensureApproval.mockReturnValue(permission.promise);
    const operation = h.write.execute({ ...h.context, args: h.args });
    h.replace({ value: { ...h.initial, revision: toImageGenerationDraftRevisionId({ raw: 'manually-edited' }) } });
    permission.resolve({ status: 'approved' });
    expect(await operation).toMatchObject({ status: 'error' }); expect(h.commit).not.toHaveBeenCalled();
  });
  it('disposes turn-local capabilities without revoking a newly created turn', async () => {
    const h = harness(), next = h.create();
    await h.write.dispose?.();
    expect(await h.read.execute({ ...h.context, args: {} })).toMatchObject({ status: 'error' });
    expect(await next[0]!.execute({ ...h.context, args: {} })).toMatchObject({ status: 'success' });
    h.binding.abort();
    expect(await next[0]!.execute({ ...h.context, args: {} })).toMatchObject({ status: 'error' });
  });
  it('registers only for the attached chat and cannot unregister a newer binding', () => {
    const h = harness();
    const detach = registerImageGenerationAssistant({ chatId: h.initial.chatId, create: h.create });
    try {
      expect(getImageGenerationToolsForChat({ chatId: toChatId({ raw: 'unrelated-chat' }) })).toEqual([]);
      expect(getImageGenerationToolsForChat({ chatId: h.initial.chatId })).toHaveLength(2);
      expect(() => registerImageGenerationAssistant({ chatId: h.initial.chatId, create: h.create })).toThrow('already connected');
    } finally {
      detach();
    }
    const detachNext = registerImageGenerationAssistant({ chatId: h.initial.chatId, create: h.create });
    try {
      detach(); expect(getImageGenerationToolsForChat({ chatId: h.initial.chatId })).toHaveLength(2);
    } finally {
      detachNext();
    }
    expect(getImageGenerationToolsForChat({ chatId: h.initial.chatId })).toEqual([]);
  });
});
