import { describe, expect, it, vi } from 'vitest';
import { toChatId, toImageGenerationBindingId, toImageGenerationDraftRevisionId, toImageGenerationSessionId, toImageGenerationStoreId } from '@/01-models/ids';
import type { ApprovalEnsureResult } from '@/01-models/tool-approval';
import { applyImageGenerationPromptEdit, type ImageGenerationPromptChange, type ImageGenerationPromptEdit, type ImageGenerationPromptTarget } from './prompt-access';

function harness() {
  const target: ImageGenerationPromptTarget = {
    storeId: toImageGenerationStoreId({ raw: 'store-aa' }), sessionId: toImageGenerationSessionId({ raw: 'session-aa' }),
    bindingId: toImageGenerationBindingId({ raw: 'binding-aa' }), chatId: toChatId({ raw: 'chat-aa' }),
    revision: toImageGenerationDraftRevisionId({ raw: 'draft-aa' }), prompt: '雨の夜景', negativePrompt: 'blur',
  };
  let current: ImageGenerationPromptTarget | undefined = { ...target };
  const controller = new AbortController();
  const readTarget = () => current;
  const commit = vi.fn(({ expected, edit }: { expected: ImageGenerationPromptTarget, edit: ImageGenerationPromptEdit }): 'applied' | 'conflict' => {
    if (!current || JSON.stringify(current) !== JSON.stringify(expected)) return 'conflict';
    current = { ...current, [edit.field]: edit.value, revision: toImageGenerationDraftRevisionId({ raw: 'draft-new' }) };
    return 'applied';
  });
  const approval = Promise.withResolvers<ApprovalEnsureResult>();
  const ensureApproval = vi.fn(async (_request: { change: ImageGenerationPromptChange }) => approval.promise);
  const options = { target, edit: { field: 'prompt', value: 'A rainy night' }, signal: controller.signal, readTarget, ensureApproval, commit };
  return { ...options, options, approval, controller, setCurrent({ value }: { value: ImageGenerationPromptTarget | undefined }) {
    current = value;
  } };
}

describe('scoped Image Generation prompt access', () => {
  it('shows the actual validated change and commits only after ordinary approval', async () => {
    const h = harness();
    const operation = applyImageGenerationPromptEdit({ ...h.options, edit: { field: 'prompt', value: '  A rainy night  ' } });
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.ensureApproval.mock.calls[0]?.[0].change).toEqual({ field: 'prompt', before: '雨の夜景', after: 'A rainy night' });
    h.approval.resolve({ status: 'approved' });
    expect(await operation).toEqual({ status: 'applied' });
    expect(h.readTarget()).toMatchObject({ prompt: 'A rainy night', negativePrompt: 'blur', revision: 'draft-new' });
  });
  it('denies without changing the draft', async () => {
    const h = harness(); h.approval.resolve({ status: 'denied' });
    expect(await applyImageGenerationPromptEdit(h.options)).toEqual({ status: 'denied' });
    expect(h.commit).not.toHaveBeenCalled(); expect(h.readTarget()).toEqual(h.target);
  });
  it('allows clearing only the negative prompt', async () => {
    const h = harness(); h.approval.resolve({ status: 'approved' });
    expect(await applyImageGenerationPromptEdit({ ...h.options, edit: { field: 'negativePrompt', value: '' } })).toEqual({ status: 'applied' });
    expect(h.readTarget()).toMatchObject({ prompt: '雨の夜景', negativePrompt: '' });
  });
  it.each([
    {}, { field: 'prompt', value: '' }, { field: 'prompt', value: ' ' }, { field: 'prompt', value: 'a'.repeat(4097) },
    { field: 'prompt', value: '\0' }, { field: 'model', value: 'another' }, { field: 'seed', value: '42' },
    { field: 'prompt', value: 'okay', generate: true }, { field: 'negativePrompt', value: '\0' },
  ])('rejects unsupported operations before prompting for approval: %j', async edit => {
    const h = harness();
    expect(await applyImageGenerationPromptEdit({ ...h.options, edit })).toEqual({ status: 'invalid_arguments' });
    expect(h.ensureApproval).not.toHaveBeenCalled(); expect(h.commit).not.toHaveBeenCalled();
  });
  const replacements: { key: string, replace: ({ target }: { target: ImageGenerationPromptTarget }) => ImageGenerationPromptTarget | undefined }[] = [
    { key: 'detach', replace: () => undefined },
    { key: 'store replacement', replace: ({ target }) => ({ ...target, storeId: toImageGenerationStoreId({ raw: 'store-bb' }) }) },
    { key: 'session switch', replace: ({ target }) => ({ ...target, sessionId: toImageGenerationSessionId({ raw: 'session-bb' }) }) },
    { key: 'chat replacement', replace: ({ target }) => ({ ...target, chatId: toChatId({ raw: 'chat-bb' }) }) },
    { key: 'reattach the same chat', replace: ({ target }) => ({ ...target, bindingId: toImageGenerationBindingId({ raw: 'binding-bb' }) }) },
  ];
  it.each(replacements)('rejects $key before permission', async ({ replace }) => {
    const h = harness(); h.setCurrent({ value: replace({ target: h.target }) });
    expect(await applyImageGenerationPromptEdit(h.options)).toEqual({ status: 'unavailable' });
    expect(h.ensureApproval).not.toHaveBeenCalled(); expect(h.commit).not.toHaveBeenCalled();
  });
  it.each(replacements)('rejects $key while waiting for permission', async ({ replace }) => {
    const h = harness(); const operation = applyImageGenerationPromptEdit(h.options);
    h.setCurrent({ value: replace({ target: h.target }) }); h.approval.resolve({ status: 'approved' });
    expect(await operation).toEqual({ status: 'unavailable' }); expect(h.commit).not.toHaveBeenCalled();
  });
  it.each(['changed prompt', 'unchanged text after undo', 'changed model/context', 'changed negative prompt'])('rejects a stale draft: %s', async cause => {
    const h = harness(); const operation = applyImageGenerationPromptEdit(h.options);
    h.setCurrent({ value: { ...h.target, revision: toImageGenerationDraftRevisionId({ raw: 'new-revision' }),
      prompt: cause === 'changed prompt' ? 'edited manually' : h.target.prompt,
      negativePrompt: cause === 'changed negative prompt' ? 'new negative' : h.target.negativePrompt,
    } });
    h.approval.resolve({ status: 'approved' });
    expect(await operation).toEqual({ status: 'stale' }); expect(h.commit).not.toHaveBeenCalled();
  });
  it('detects text changes even when the controller accidentally reuses a revision', async () => {
    const h = harness(); const operation = applyImageGenerationPromptEdit(h.options);
    h.setCurrent({ value: { ...h.target, prompt: 'manually changed' } }); h.approval.resolve({ status: 'approved' });
    expect(await operation).toEqual({ status: 'stale' }); expect(h.commit).not.toHaveBeenCalled();
  });
  it('revalidates even when allow-for-chat or global permission is already granted', async () => {
    const h = harness(); h.approval.resolve({ status: 'approved' });
    const operation = applyImageGenerationPromptEdit(h.options);
    h.setCurrent({ value: undefined });
    expect(await operation).toEqual({ status: 'unavailable' }); expect(h.commit).not.toHaveBeenCalled();
  });
  it.each(['before', 'during'] as const)('does not commit after cancellation %s permission', async timing => {
    const h = harness();
    if (timing === 'before') h.controller.abort();
    const operation = applyImageGenerationPromptEdit(h.options);
    h.controller.abort(); h.approval.resolve({ status: 'approved' });
    expect(await operation).toEqual({ status: 'cancelled' }); expect(h.commit).not.toHaveBeenCalled();
  });
  it('does not expose the accepted edit or target to mutable callers and approval presenters', async () => {
    const h = harness(); const operation = applyImageGenerationPromptEdit(h.options);
    h.options.edit.value = 'mutated after submission'; h.target.prompt = 'mutated origin';
    const change = h.ensureApproval.mock.calls[0]?.[0].change;
    if (change) change.after = 'mutated preview';
    h.approval.resolve({ status: 'approved' });
    expect(await operation).toEqual({ status: 'applied' }); expect(h.readTarget()?.prompt).toBe('A rainy night');
  });
  it('allows only one of two concurrently approved edits of the same revision', async () => {
    const h = harness(); const operations = [applyImageGenerationPromptEdit(h.options), applyImageGenerationPromptEdit(h.options)];
    h.approval.resolve({ status: 'approved' });
    expect(await Promise.all(operations)).toEqual([{ status: 'applied' }, { status: 'stale' }]);
    expect(h.commit).toHaveBeenCalledTimes(1);
  });
  it('returns a conflict from the final compare-and-set without retrying against another draft', async () => {
    const h = harness(); h.commit.mockReturnValue('conflict'); h.approval.resolve({ status: 'approved' });
    expect(await applyImageGenerationPromptEdit(h.options)).toEqual({ status: 'stale' }); expect(h.commit).toHaveBeenCalledTimes(1);
  });
  it('does not mutate the draft on approval infrastructure failure', async () => {
    const h = harness(); const operation = applyImageGenerationPromptEdit(h.options); h.approval.reject(new Error('approval failed'));
    await expect(operation).rejects.toThrow('approval failed'); expect(h.commit).not.toHaveBeenCalled();
  });
});
