// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { recognitionFile } from './recognition.test-support';
import { inspectSpeechRecognitionCandidate } from './model-file';
import { inspectStoredSpeechRecognitionModel, openStoredSpeechRecognitionModel } from './models';
import { speechRecognitionModelCatalog } from './model-catalog';

const capture = vi.hoisted(() => vi.fn());
vi.mock('@/features/llama-cpp-browser/model-files', () => ({ llamaCppBrowserModelFiles: { captureModelFiles: capture } }));

it.each(['qwen3-asr', 'fastconformer'])('recognizes %s by speech task metadata and rechecks replaced inventory files', async architecture => {
  const file = await recognitionFile({ architecture, task: 'recognition', sampleRate: 16000 });
  capture.mockResolvedValue({ primaryRelativePath: 'model', files: [{ relativePath: 'model', file }] });
  expect(await inspectStoredSpeechRecognitionModel({ modelId: 'chosen', signal: undefined })).toMatchObject({ kind: 'recognition', info: { architecture, task: 'recognition', sampleRate: 16000 } });
  expect(await openStoredSpeechRecognitionModel({ modelId: 'chosen', signal: undefined })).toBe(file);
  const replaced = await recognitionFile({ architecture: 'haru', task: 'dialogue', sampleRate: 24000 });
  capture.mockResolvedValue({ primaryRelativePath: 'model', files: [{ relativePath: 'model', file: replaced }] });
  await expect(openStoredSpeechRecognitionModel({ modelId: 'chosen', signal: undefined })).rejects.toThrow();
});

it('rejects companion selection and invalid ASR rates, while leaving other tasks unclassified', async () => {
  const file = await recognitionFile({ architecture: 'fastconformer', task: 'recognition', sampleRate: 16000 });
  capture.mockResolvedValue({ primaryRelativePath: 'model', files: [{ relativePath: 'model', file }, { relativePath: 'other', file }] });
  await expect(inspectStoredSpeechRecognitionModel({ modelId: 'ambiguous', signal: undefined })).rejects.toThrow();
  const invalid = await recognitionFile({ architecture: 'qwen3-asr', task: 'recognition', sampleRate: 0 });
  await expect(inspectSpeechRecognitionCandidate({ file: invalid, name: invalid.name, signal: undefined })).rejects.toThrow();
  const other = await recognitionFile({ architecture: 'fastconformer', task: 'detection', sampleRate: 16000 });
  expect(await inspectSpeechRecognitionCandidate({ file: other, name: other.name, signal: undefined })).toEqual({ kind: 'other' });
});

it('offers the four requested single-file speech.cpp conversions without companion downloads', () => {
  expect(speechRecognitionModelCatalog.map(model => model.name)).toEqual(['Qwen3-ASR 0.6B', 'Qwen3-ASR 1.7B', 'ReazonSpeech v2', 'Parakeet TDT-CTC 0.6B Japanese']);
  expect(speechRecognitionModelCatalog.every(model => model.companion === undefined && model.quantizationHints.every(choice => choice.hfRepository.startsWith('sakasegawa/')))).toBe(true);
});
