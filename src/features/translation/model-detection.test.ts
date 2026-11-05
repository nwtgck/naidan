import { describe, expect, it, vi } from 'vitest';
import { ggufFixture, textMetadata, ggufInteger, ggufString, concatenateGguf } from '@/features/audio-generation/test-utils/gguf.test-support';
import { inspectTranslationGguf } from './model-detection';
const template = `dataset translation input output target_lang source_lang <|plamo:tag|> <|plamo:msg|> <|plamo:key|> <|plamo:val|>`;

function file({ architecture, chatTemplate }: { architecture: string, chatTemplate: string }) {
  return ggufFixture({ entries: [textMetadata({ key: 'general.architecture', value: architecture }), textMetadata({ key: 'tokenizer.chat_template', value: chatTemplate })] });
}

describe('translation model metadata', () => {
  it('recognizes translation templates without depending on the filename or declared parameter count', async () => {
    expect(await inspectTranslationGguf({ file: file({ architecture: 'plamo3', chatTemplate: template }), signal: new AbortController().signal })).toEqual({ status: 'supported', profileId: 'plamo3-translate' });
  });

  it.each([
    { architecture: 'plamo3', chatTemplate: 'messages user assistant' },
    { architecture: 'llama', chatTemplate: template },
    { architecture: 'plamo3', chatTemplate: 'translation target_lang source_lang' },
  ])('does not mistake an ordinary or incompatible model for a translation model', async fixture => {
    expect(await inspectTranslationGguf({ file: file(fixture), signal: new AbortController().signal })).toEqual({ status: 'unsupported' });
  });

  it('can read the publisher template even when it exceeds the old audio metadata limit', async () => {
    const blob = file({ architecture: 'plamo3', chatTemplate: ' '.repeat(6000) + template });
    expect((await inspectTranslationGguf({ file: blob, signal: new AbortController().signal })).status).toBe('supported');
  });

  it('skips preceding tokenizer arrays instead of retaining the vocabulary', async () => {
    const tokens = { key: 'tokenizer.ggml.tokens', type: 9, value: concatenateGguf({ parts: [ggufInteger({ value: 8, bytes: 4 }), ggufInteger({ value: 3, bytes: 8 }), ...['token1', 'token2', 'token3'].map(value => ggufString({ value }))] }) };
    const blob = ggufFixture({ entries: [tokens, textMetadata({ key: 'general.architecture', value: 'plamo3' }), textMetadata({ key: 'tokenizer.chat_template', value: template })] });
    expect((await inspectTranslationGguf({ file: blob, signal: new AbortController().signal })).status).toBe('supported');
  });

  it('bounds retained templates and rejects incomplete files', async () => {
    await expect(inspectTranslationGguf({ file: file({ architecture: 'plamo3', chatTemplate: 'x'.repeat(65537) }), signal: new AbortController().signal })).rejects.toThrow();
    const blob = file({ architecture: 'plamo3', chatTemplate: template });
    await expect(inspectTranslationGguf({ file: blob.slice(0, 20), signal: new AbortController().signal })).rejects.toThrow();
  });

  it('does not read any data when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const blob = file({ architecture: 'plamo3', chatTemplate: template });
    const slice = vi.spyOn(blob, 'slice');
    await expect(inspectTranslationGguf({ file: blob, signal: controller.signal })).rejects.toThrow();
    expect(slice).not.toHaveBeenCalled();
  });
});
