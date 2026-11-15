// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { speechModelFile } from './worker/model-file.test-support';
import { inspectStoredSpeechModel, openStoredSpeechModel } from './models';

const capture = vi.hoisted(() => vi.fn());
vi.mock('@/features/llama-cpp-browser/model-files', () => ({ llamaCppBrowserModelFiles: { captureModelFiles: capture } }));

it('captures the exact primary File and rechecks a replaced model before acceptance', async () => {
  const speech = await speechModelFile({ architecture: 'haru', name: 'any.gguf', frameSamples: 3200 });
  capture.mockResolvedValue({ primaryRelativePath: 'any.gguf', files: [{ relativePath: 'any.gguf', file: speech }] });
  expect((await inspectStoredSpeechModel({ modelId: 'registered-model', signal: undefined })).kind).toBe('speech');
  expect(await openStoredSpeechModel({ modelId: 'registered-model', signal: undefined })).toBe(speech);
  const other = await speechModelFile({ architecture: 'llama', name: 'any.gguf', frameSamples: 3200 });
  capture.mockResolvedValue({ primaryRelativePath: 'any.gguf', files: [{ relativePath: 'any.gguf', file: other }] });
  await expect(openStoredSpeechModel({ modelId: 'registered-model', signal: undefined })).rejects.toThrow();
});

it('does not reinterpret ordinary multi-file models and rejects ambiguous Haru inputs', async () => {
  const other = await speechModelFile({ architecture: 'llama', name: 'model.gguf', frameSamples: 3200 });
  capture.mockResolvedValue({ primaryRelativePath: 'model.gguf', files: [{ relativePath: 'model.gguf', file: other }, { relativePath: 'companion.gguf', file: other }] });
  expect(await inspectStoredSpeechModel({ modelId: 'multimodal', signal: undefined })).toEqual({ kind: 'other' });
  const speech = await speechModelFile({ architecture: 'haru', name: 'model.gguf', frameSamples: 3200 });
  capture.mockResolvedValue({ primaryRelativePath: 'model.gguf', files: [{ relativePath: 'model.gguf', file: speech }, { relativePath: 'companion.gguf', file: speech }] });
  await expect(inspectStoredSpeechModel({ modelId: 'ambiguous', signal: undefined })).rejects.toThrow();
});
