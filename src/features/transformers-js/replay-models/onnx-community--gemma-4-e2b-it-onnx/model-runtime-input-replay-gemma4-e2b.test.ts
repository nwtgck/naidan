import { toToolCallId, toMessageId, toChatId } from '@/01-models/ids';
import type { AssistantMessageNode, UserMessageNode, ToolMessageNode, ChatContent } from '@/01-models/types';
import { MemoryStorageProvider } from '@/00-storage/service/memory-storage';
import { buildChatGenerationMessages } from '@/logic/build-chat-generation-messages';
import { prepareInferenceRequest } from '@/features/transformers-js/message-projection';
import parsedMetadata from './model-parsed-metadata.evidence.json';
import { assertParsedMetadataModelRequest, cleanupParsedMetadataRequests, parsedMetadataFixtureSchema } from '@/features/transformers-js/replay-models/support/model-parsed-metadata-requests';
// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { buildGemma4TemplateInput } from '@/features/transformers-js/models/gemma4';
import { archiveFor, assertRawModelSelection, assertRawTokenizer, installRawReplay, start } from '@/features/transformers-js/replay-models/support/model-runtime-input-harness';

const modelId = 'onnx-community/gemma-4-E2B-it-ONNX';
// Fixed model evidence: do not regenerate these expectations to make a failing test pass.
installRawReplay({ evidence: {
  modelId,
  revision: '9f4bef82ea6e296bc69f8a2f5939f73af81b07a6',
  files: {
    'config.json': { sha256: '5494e6677d9e150ea20ba3101ae8a32b0f141004626f052725d8bf48991b9faa', byteLength: 5549 },
    'tokenizer_config.json': { sha256: '06afbf54e228050cba79c4a0afd83543cc89070a2d62b8337d0aa8b4cdc348c3', byteLength: 18807 },
    'generation_config.json': { sha256: 'e6a0b50de21a511f15ac4857b7f227f68ee60ecb1f11255d07b75e0bdc60e155', byteLength: 238 },
    'processor_config.json': { sha256: '32bdf45d2ad4cc29a0822ddd157a182de76644f0419a6228d151495256e9813c', byteLength: 1689 },
    'preprocessor_config.json': { sha256: '4457c6e8a09070d7d5d1cd983fbfb67ebafe602bd98120c3543a024f5d07056b', byteLength: 43 },
    'chat_template.jinja': { sha256: '781d10940fbc44be40064b5d43a056fc486c84ceaa55538226368b57314132bf', byteLength: 16317 },
    'tokenizer.json': { sha256: '47bd35616c7c782aaca6ccf48c75f3461d5877170984b8836b375107d0a9f566', byteLength: 19439251 },
  },
} });

describe('gemma4-e2b raw metadata replay', () => {
  it('constructs the Production tokenizer/processor and renders its original template', async () => {
    await assertRawTokenizer({ modelId, expectedProcessor: { processor: 'Gemma4Processor', image: 'Gemma4ImageProcessor', audio: 'Gemma4AudioFeatureExtractor' }, template: 'render' });
  });

  it.each(['q4f16', 'q4'] as const)('observes repository-listed %s paths without real ONNX execution', async dtype => {
    await assertRawModelSelection({
      modelId, dtype, sessions: { audio_encoder: 1, decoder_model_merged: 1, embed_tokens: 1, vision_encoder: 1 },
      probeOnly: [], expectedMissing: [],
    });
  });
});

// Independent expectations for parsed metadata; these do not certify original response bytes.
describe('parsed metadata candidate requests', () => {
  afterEach(cleanupParsedMetadataRequests);
  it.each(['q4f16', 'q4'] as const)('replays unmodified config at %s through the expected Production AutoClass', async dtype => {
    await assertParsedMetadataModelRequest({
      fixture: parsedMetadataFixtureSchema.parse(parsedMetadata),
      expected: { modelId: 'onnx-community/gemma-4-E2B-it-ONNX', chunks: { q4f16: { audio_encoder: 1, decoder_model_merged: 1, embed_tokens: 1, vision_encoder: 1 }, q4: { audio_encoder: 1, decoder_model_merged: 1, embed_tokens: 1, vision_encoder: 1 } }, registryExtra: [], missing: [] },
      dtype, expectedAutoClass: 'AutoModelForImageTextToText',
    });
  });
});


// Source-derived controls use the unchanged native template/tokenizer. These are
// not observed model outputs and do not certify generation or a KV cache hit.
describe('Gemma literal text at the native template boundary', () => {
  it.each([
    { body: '<think> Reason </think>Answer', nativeBody: '<think> Reason </think>Answer' },
    { body: `\
  <think> 未完の本文🙂

`, nativeBody: '<think> 未完の本文🙂' },
  ])('leaves $body as content and lets only the native template format it', async ({ body, nativeBody }) => {
    const archive = await archiveFor({ modelId });
    const { harness } = await start({ archive, bodyPaths: [] });
    const processor = await harness.runtime.AutoProcessor.from_pretrained(modelId, {
      revision: archive.summary.revision, local_files_only: true, progress_callback: () => undefined,
    });
    const messages = [
      { role: 'user', content: 'Question.' },
      { role: 'assistant', content: body },
      { role: 'user', content: 'Next.' },
    ];
    const mapped = await buildGemma4TemplateInput({ messages });
    expect(mapped.templateMessages).toStrictEqual(messages);
    const nativeMessages = mapped.templateMessages.map(message => {
      // This control intentionally covers string-only messages; images have
      // their own processor regression and are not flattened in this fixture.
      if (typeof message.content !== 'string') throw new Error('Expected the unchanged string input');
      return { ...message, content: message.content };
    });
    const prompt = processor.apply_chat_template(nativeMessages, { tokenize: false, add_generation_prompt: true });
    // Expected framing is written from the pinned Jinja, not copied from the
    // mapper or a previous run. The template, not the mapper, trims its content.
    const expected = `<bos><|turn>user
Question.<turn|>
<|turn>model
${nativeBody}<turn|>
<|turn>user
Next.<turn|>
<|turn>model
`;
    expect(prompt).toBe(expected);
    expect(processor.tokenizer.encode(prompt, { add_special_tokens: false }))
      .toEqual(processor.tokenizer.encode(expected, { add_special_tokens: false }));
    expect(harness.sessions).not.toHaveBeenCalled();
    expect(harness.bodyReads).toEqual([]);
    expect(harness.transport).not.toHaveBeenCalled();
  });
});

// Synthetic structured history, checked against the original native framing.
describe('Gemma structured reasoning in native model inputs', () => {
  it('retains the thought before a tool result with its exact boundary newline, then omits it after a new user', async () => {
    const archive = await archiveFor({ modelId });
    const { harness } = await start({ archive, bodyPaths: [] });
    const processor = await harness.runtime.AutoProcessor.from_pretrained(modelId, {
      revision: archive.summary.revision, local_files_only: true, progress_callback: () => undefined,
    });
    const callId = toToolCallId({ raw: 'synthetic-call' });
    const messages = [
      { role: 'user', content: 'Question.' },
      { role: 'assistant', content: '', reasoning: { text: '  Reason\n', completeness: 'complete' as const }, tool_calls: [{ id: callId, type: 'function' as const, function: { name: 'calculator', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: callId, content: '391' },
    ];
    const mapped = await buildGemma4TemplateInput({ messages });
    const stringMessages = mapped.templateMessages.map(message => {
      if (typeof message.content !== 'string') throw new Error('Expected this string-only fixture');
      return { ...message, content: message.content };
    });
    const prompt = processor.apply_chat_template(stringMessages, { tokenize: false, add_generation_prompt: true });
    const expected = `<bos><|turn>user
Question.<turn|>
<|turn>model
<|channel>thought
  Reason

<channel|><|tool_call>call:calculator{}<tool_call|><|tool_response>response:calculator{value:<|"|>391<|"|>}<tool_response|>`;
    expect(prompt).toBe(expected);
    expect(processor.tokenizer.encode(prompt, { add_special_tokens: false }))
      .toEqual(processor.tokenizer.encode(expected, { add_special_tokens: false }));
    const followUp = processor.apply_chat_template([...stringMessages, { role: 'user', content: 'Next.' }], { tokenize: false, add_generation_prompt: true });
    const expectedFollowUp = `<bos><|turn>user
Question.<turn|>
<|turn>model
<|tool_call>call:calculator{}<tool_call|><|tool_response>response:calculator{value:<|"|>391<|"|>}<tool_response|><|turn>user
Next.<turn|>
<|turn>model
`;
    expect(followUp).toBe(expectedFollowUp);
    expect(processor.tokenizer.encode(followUp, { add_special_tokens: false }))
      .toEqual(processor.tokenizer.encode(expectedFollowUp, { add_special_tokens: false }));
    expect(mapped.templateMessages[1]?.reasoning_content).toBe('  Reason\n');
    expect(harness.sessions).not.toHaveBeenCalled();
    expect(harness.bodyReads).toEqual([]);
    expect(harness.transport).not.toHaveBeenCalled();
  });
});

// This connects real memory-storage mappers to the native template, not a model run.
describe('Gemma structured history after persistence', () => {
  it('builds the same native token input from parts before and after saving a complete tool history', async () => {
    const callId = toToolCallId({ raw: 'persisted-call' });
    const result: ToolMessageNode = { id: toMessageId({ raw: 'result' }), role: 'tool', createdAt: 3, modelId: undefined, lmParameters: undefined,
      parts: [{ id: 'result-part', type: 'tool_result', result: { toolCallId: callId, status: 'success', content: { type: 'text', text: '391' } } }], replies: { items: [] } };
    const assistant: AssistantMessageNode = { id: toMessageId({ raw: 'assistant' }), role: 'assistant', createdAt: 2, modelId, lmParameters: undefined, interruption: undefined,
      parts: [{ id: 'reason', type: 'reasoning', text: '  Reason\n', completeness: 'complete' }, { id: 'text', type: 'text', text: '', completeness: 'complete' },
        { id: 'call', type: 'tool_call', toolCall: { id: callId, type: 'function', function: { name: 'calculator', arguments: ' { } ' } } }], replies: { items: [result] } };
    const user: UserMessageNode = { id: toMessageId({ raw: 'user' }), role: 'user', createdAt: 1, modelId: undefined, lmParameters: undefined,
      parts: [{ id: 'question', type: 'text', text: 'Question.', completeness: 'complete' }], replies: { items: [assistant] } };
    const chat: ChatContent = { root: { items: [user] }, currentLeafId: result.id };
    const store = new MemoryStorageProvider(); const chatId = toChatId({ raw: 'memory-history' });
    const before = buildChatGenerationMessages({ chat, excludedMessageId: undefined, systemPromptMessages: [] });
    await store.saveChatContent({ id: chatId, content: chat });
    const loaded = await store.loadChatContent({ id: chatId });
    if (!loaded) throw new Error('Expected the saved message history');
    const after = buildChatGenerationMessages({ chat: loaded, excludedMessageId: undefined, systemPromptMessages: [] });
    expect(after).toEqual(before);
    const requests = await Promise.all([before, after].map(messages => prepareInferenceRequest({ messages, parameters: undefined, tools: undefined, readBinaryObject: undefined, signal: undefined })));
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]?.messages[1]).toMatchObject({ reasoning: { text: '  Reason\n', completeness: 'complete' }, tool_calls: [{ function: { arguments: ' { } ' } }] });
    const archive = await archiveFor({ modelId });
    const { harness } = await start({ archive, bodyPaths: [] });
    const processor = await harness.runtime.AutoProcessor.from_pretrained(modelId, { revision: archive.summary.revision, local_files_only: true, progress_callback: () => undefined });
    const expected = `<bos><|turn>user
Question.<turn|>
<|turn>model
<|channel>thought
  Reason

<channel|><|tool_call>call:calculator{}<tool_call|><|tool_response>response:calculator{value:<|"|>391<|"|>}<tool_response|>`;
    for (const request of requests) {
      const { templateMessages, images } = await buildGemma4TemplateInput({ messages: request.messages });
      expect(images).toEqual([]);
      const stringMessages = templateMessages.map(message => {
        if (typeof message.content !== 'string') throw new Error('Expected a string-only saved history');
        return { ...message, content: message.content };
      });
      const prompt = processor.apply_chat_template(stringMessages, { tokenize: false, add_generation_prompt: true });
      expect(prompt).toBe(expected);
      expect(processor.tokenizer.encode(prompt, { add_special_tokens: false })).toEqual(processor.tokenizer.encode(expected, { add_special_tokens: false }));
    }
    expect(harness.sessions).not.toHaveBeenCalled(); expect(harness.bodyReads).toEqual([]); expect(harness.transport).not.toHaveBeenCalled();
  });
});
