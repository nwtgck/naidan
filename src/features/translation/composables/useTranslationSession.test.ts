import { describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { flushPromises } from '@vue/test-utils';
import { LlamaCppBrowserError, type GenerationResult } from '@/features/llama-cpp-browser/types';
import type { LlamaCppBrowserService } from '@/features/llama-cpp-browser/service-contract';
import type { InspectTranslationModel, TranslationDraft } from '@/features/translation/types';
import { useTranslationSession } from './useTranslationSession';

function fixture() {
  const scope = effectScope();
  const inspect = vi.fn<InspectTranslationModel>().mockResolvedValue({ status: 'supported', profileId: 'plamo3-translate' });
  const result: GenerationResult = { content: 'Hello', reasoningContent: '', toolCalls: [], finishReason: 'stop' };
  const generate = vi.fn<LlamaCppBrowserService['generate']>().mockResolvedValue(result);
  const runGenerationOperation = vi.fn<LlamaCppBrowserService['runGenerationOperation']>().mockImplementation(async ({ operation, signal }) => {
    await operation({ scope: { signal: signal!, generate } });
  });
  const session = scope.run(() => useTranslationSession({ service: { runGenerationOperation }, inspectModel: inspect }))!;
  const draft: TranslationDraft = { modelId: 'model.gguf', text: 'こんにちは', sourceLang: 'ja', targetLang: 'en', form: 'default', context: '', glossary: [] };
  return {
    session,
    draft,
    inspect,
    generate,
    runGenerationOperation,
    scope,
    result,
    [Symbol.dispose]() {
      scope.stop();
    },
  };
}

describe('translation operation ownership', () => {
  it('streams text and replaces it with the final parser result without duplicating it', async () => {
    using f = fixture();
    f.generate.mockImplementation(async ({ onEvent }) => {
      await onEvent({ event: { type: 'text', text: 'Hel' } });
      expect(f.session.output.value).toBe('Hel');
      expect(f.session.phase.value).toBe('generating');
      await onEvent({ event: { type: 'text', text: 'lo' } });
      return f.result;
    });
    await f.session.translate({ draft: f.draft });
    expect(f.session.output.value).toBe('Hello');
    expect(f.session.phase.value).toBe('complete');
    expect(f.session.busy.value).toBe(false);
    expect(f.generate.mock.calls[0]?.[0].input.chatTemplateKwargs).toEqual({ source_lang: 'ja', target_lang: 'en' });
  });

  it('ignores delayed text and progress after an operation has completed', async () => {
    using f = fixture();
    await f.session.translate({ draft: f.draft });
    await f.generate.mock.calls[0]?.[0].onEvent({ event: { type: 'text', text: 'late' } });
    f.runGenerationOperation.mock.calls[0]?.[0].onProgress?.({ progress: { phase: 'generating', completed: 1, total: 4096 } });
    expect(f.session.output.value).toBe('Hello');
    expect(f.session.phase.value).toBe('complete');
    expect(f.session.progress.value).toBeUndefined();
  });

  it('snapshots text and glossary before metadata inspection awaits', async () => {
    using f = fixture();
    const pending = Promise.withResolvers<Awaited<ReturnType<InspectTranslationModel>>>();
    f.inspect.mockReturnValue(pending.promise);
    f.draft.glossary = [{ source: 'a', target: 'b' }];
    const work = f.session.translate({ draft: f.draft });
    f.draft.text = 'changed';
    f.draft.glossary[0]!.target = 'changed';
    pending.resolve({ status: 'supported', profileId: 'plamo3-translate' });
    await work;
    expect(f.generate.mock.calls[0]?.[0].input.messages[0]?.content).toBe('こんにちは');
    expect(f.generate.mock.calls[0]?.[0].input.chatTemplateKwargs?.glossary).toEqual([{ source: 'a', target: 'b' }]);
  });

  it('keeps partial output on stop and ignores late text and a normal completion after cancellation', async () => {
    using f = fixture();
    const pending = Promise.withResolvers<GenerationResult>();
    f.generate.mockImplementation(async ({ onEvent }) => {
      await onEvent({ event: { type: 'text', text: 'part' } });
      return pending.promise;
    });
    const work = f.session.translate({ draft: f.draft });
    await flushPromises();
    f.session.stop();
    expect(f.session.phase.value).toBe('stopping');
    expect(f.generate.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    await f.generate.mock.calls[0]?.[0].onEvent({ event: { type: 'text', text: 'late' } });
    pending.resolve(f.result);
    await work;
    expect(f.session.phase.value).toBe('stopped');
    expect(f.session.output.value).toBe('part');
  });

  it('does not submit a second operation while one is stopping', async () => {
    using f = fixture();
    const pending = Promise.withResolvers<GenerationResult>();
    f.generate.mockReturnValue(pending.promise);
    const work = f.session.translate({ draft: f.draft });
    await flushPromises();
    f.session.stop();
    await f.session.translate({ draft: f.draft });
    expect(f.generate).toHaveBeenCalledOnce();
    pending.resolve(f.result);
    await work;
  });

  it('never lets a reset operation overwrite a newer request', async () => {
    using f = fixture();
    const pending = Promise.withResolvers<GenerationResult>();
    f.generate.mockReturnValueOnce(pending.promise);
    const old = f.session.translate({ draft: f.draft });
    await flushPromises();
    f.session.reset();
    await f.session.translate({ draft: { ...f.draft, targetLang: 'ko' } });
    expect(f.generate).toHaveBeenCalledOnce();
    expect(f.session.busy.value).toBe(true);
    pending.resolve({ ...f.result, content: 'old' });
    await old;
    expect(f.session.output.value).toBe('');
    await f.session.translate({ draft: { ...f.draft, targetLang: 'ko' } });
    expect(f.session.output.value).toBe('Hello');
    expect(f.session.phase.value).toBe('complete');
  });

  it('cancels metadata inspection and prevents native work after disposal', async () => {
    using f = fixture();
    const pending = Promise.withResolvers<Awaited<ReturnType<InspectTranslationModel>>>();
    f.inspect.mockReturnValue(pending.promise);
    const work = f.session.translate({ draft: f.draft });
    f.scope.stop();
    expect(f.inspect.mock.calls[0]?.[0].signal.aborted).toBe(true);
    pending.resolve({ status: 'supported', profileId: 'plamo3-translate' });
    await work;
    expect(f.runGenerationOperation).not.toHaveBeenCalled();
    expect(f.session.output.value).toBe('');
  });

  it('rejects unsupported models and invalid inputs before acquiring a generation lane', async () => {
    using f = fixture();
    f.inspect.mockResolvedValueOnce({ status: 'unsupported' });
    await f.session.translate({ draft: f.draft });
    expect(f.session.issue.value).toBe('unsupported-model');
    await f.session.translate({ draft: { ...f.draft, targetLang: 'invalid' } });
    expect(f.session.issue.value).toBe('unsupported-target');
    expect(f.runGenerationOperation).not.toHaveBeenCalled();
  });

  it('distinguishes output limits from complete translations', async () => {
    using f = fixture();
    f.generate.mockResolvedValue({ ...f.result, finishReason: 'length' });
    await f.session.translate({ draft: f.draft });
    expect(f.session.phase.value).toBe('truncated');
    expect(f.session.output.value).toBe('Hello');
  });

  it('does not claim success for an empty model response', async () => {
    using f = fixture();
    f.generate.mockResolvedValue({ ...f.result, content: ' ' });
    await f.session.translate({ draft: f.draft });
    expect(f.session.phase.value).toBe('error');
    expect(f.session.issue.value).toBe('unexpected-output');
  });

  it('does not execute or display model tool calls as translated text', async () => {
    using f = fixture();
    f.generate.mockImplementation(async ({ onEvent }) => {
      await onEvent({ event: { type: 'tool_call_start', index: 0 } });
      return f.result;
    });
    await f.session.translate({ draft: f.draft });
    expect(f.session.issue.value).toBe('unexpected-output');
  });

  it('shows actual operation progress and keeps runtime errors separate from validation', async () => {
    using f = fixture();
    f.runGenerationOperation.mockImplementation(async ({ onProgress }) => {
      onProgress?.({ progress: { phase: 'prefill', completed: 5, total: 10 } });
      expect(f.session.phase.value).toBe('prefill');
      expect(f.session.progress.value?.completed).toBe(5);
      throw new LlamaCppBrowserError({ code: 'context-full' });
    });
    await f.session.translate({ draft: f.draft });
    expect(f.session.failure.value).toBe('context-full');
    expect(f.session.issue.value).toBeUndefined();
    expect(f.session.busy.value).toBe(false);
  });
});
