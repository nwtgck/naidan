import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareProductionRuntimeArtifacts } from '@/features/transformers-js/download-verification/logic/prepare-production-runtime-artifacts';
import { createDownloadVerificationRuntimeArtifactPreparationWorkerClient } from '@/features/transformers-js/download-verification/runtime-artifact-preparation-worker/client-hosted';

vi.mock('@/features/transformers-js/download-verification/runtime-artifact-preparation-worker/client-hosted', () => ({
  createDownloadVerificationRuntimeArtifactPreparationWorkerClient: vi.fn(),
}));

const REVISION = '0123456789abcdef0123456789abcdef01234567';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('prepareProductionRuntimeArtifacts', () => {
  it('returns the Production runtime artifact route and always disposes the fresh worker', async () => {
    const dispose = vi.fn(async () => {});
    vi.mocked(createDownloadVerificationRuntimeArtifactPreparationWorkerClient).mockReturnValue({
      prepareModelRuntimeArtifacts: vi.fn(async () => ({
        processor: 'qwen3_5-processor' as const,
        modelType: 'qwen3_5_text',
      })),
      dispose,
    });

    await expect(prepareProductionRuntimeArtifacts({
      modelId: 'Qwen/Qwen3.5-2B-ONNX',
      revision: REVISION,
    })).resolves.toEqual({
      modelId: 'Qwen/Qwen3.5-2B-ONNX',
      revision: REVISION,
      status: 'prepared',
      processor: 'qwen3_5-processor' as const,
      modelType: 'qwen3_5_text',
      observationMethod: 'transformers-runtime-artifact-preparation',
      error: undefined,
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });



  it('preserves prepared runtime artifacts when dedicated worker disposal reports a remote release failure', async () => {
    vi.mocked(createDownloadVerificationRuntimeArtifactPreparationWorkerClient).mockReturnValue({
      prepareModelRuntimeArtifacts: vi.fn(async () => ({
        processor: 'qwen3_5-processor' as const,
        modelType: 'qwen3_5_text',
      })),
      dispose: vi.fn(async () => {
        throw new Error('remote release failed');
      }),
    });

    await expect(prepareProductionRuntimeArtifacts({
      modelId: 'Qwen/Qwen3.5-2B-ONNX',
      revision: REVISION,
    })).resolves.toMatchObject({
      status: 'prepared',
      processor: 'qwen3_5-processor' as const,
      modelType: 'qwen3_5_text',
    });
  });

  it('sanitizes signed URLs in preparation failures', async () => {
    const dispose = vi.fn(async () => {});
    vi.mocked(createDownloadVerificationRuntimeArtifactPreparationWorkerClient).mockReturnValue({
      prepareModelRuntimeArtifacts: vi.fn(async () => {
        throw new Error(`failed https://huggingface.co/org/repo/resolve/${REVISION}/tokenizer.json?X-Amz-Signature=secret#fragment`);
      }),
      dispose,
    });

    const result = await prepareProductionRuntimeArtifacts({ modelId: 'org/repo', revision: REVISION });

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        name: 'Error',
        message: `failed https://huggingface.co/org/repo/resolve/${REVISION}/tokenizer.json`,
      },
    });
    expect(result.error?.message).not.toContain('secret');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the active worker when aborted', async () => {
    const dispose = vi.fn(async () => {});
    vi.mocked(createDownloadVerificationRuntimeArtifactPreparationWorkerClient).mockReturnValue({
      prepareModelRuntimeArtifacts: vi.fn(async () => await new Promise<never>(() => {})),
      dispose,
    });
    const controller = new AbortController();

    const operation = prepareProductionRuntimeArtifacts({
      modelId: 'org/repo',
      revision: REVISION,
      signal: controller.signal,
    });
    controller.abort();

    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
