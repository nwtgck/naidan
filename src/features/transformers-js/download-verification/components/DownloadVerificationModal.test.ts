import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import DownloadVerificationModal from '@/features/transformers-js/download-verification/components/DownloadVerificationModal.vue';
import { collectDownloadVerificationEvidence } from '@/features/transformers-js/download-verification/logic/collect-download-verification-evidence';
import { createModelSupportInvestigationEvidenceWorkerClient } from '@/features/transformers-js/model-support-investigation/evidence-worker/client-hosted';
import { ensureAllStringsForTest } from '@/strings/test-utils';

vi.mock('@/features/transformers-js/download-verification/logic/collect-download-verification-evidence', () => ({
  collectDownloadVerificationEvidence: vi.fn(),
}));

vi.mock('@/features/transformers-js/model-support-investigation/evidence-worker/client-hosted', () => ({
  createModelSupportInvestigationEvidenceWorkerClient: vi.fn(),
}));

vi.mock('lucide-vue-next', () => ({
  AlertCircleIcon: { template: '<span />' },
  CheckCircle2Icon: { template: '<span />' },
  DownloadCloudIcon: { template: '<span />' },
  DownloadIcon: { template: '<span />' },
  Loader2Icon: { template: '<span />' },
  ShieldCheckIcon: { template: '<span />' },
  XIcon: { template: '<span />' },
}));

const revision = '0123456789abcdef0123456789abcdef01234567';

function evidence({ withObservation = true }: { withObservation?: boolean } = {}) {
  const observation = {
    modelId: 'org/model',
    revision,
    autoClass: 'AutoModelForCausalLM' as const,
    candidate: { device: 'webgpu' as const, dtype: 'q4' as const },
    status: 'observed' as const,
    observationMethod: 'held-model-artifact-fetch-quiescence' as const,
    quiescenceMs: 500,
    timeoutMs: 10_000,
    paths: ['onnx/model_q4.onnx'],
    requests: [{ path: 'onnx/model_q4.onnx', url: `https://huggingface.co/org/model/resolve/${revision}/onnx/model_q4.onnx` }],
    error: undefined,
  };
  return {
    schemaVersion: 1 as const,
    runId: 'run-1',
    mode: 'probe-only' as const,
    run: {
      modelId: 'org/model',
      normalizedModelId: 'org/model',
      requestedRevision: 'main' as const,
      resolvedRevision: revision,
      repositoryFileCount: 1,
      repositoryFiles: [{ path: 'onnx/model_q4.onnx', size: 10, blobId: undefined, lfsOid: undefined, lfsSha256: undefined, lfsSize: undefined }],
      transportObservations: [{
        path: 'onnx/model_q4.onnx',
        method: 'GET-range' as const,
        status: 206,
        redirected: true,
        finalUrl: 'https://cdn.example.test/model_q4.onnx',
        finalOrigin: 'https://cdn.example.test',
        contentLength: 4096,
        contentRange: 'bytes 0-4095/1000000',
        acceptRanges: 'bytes',
        contentType: 'application/octet-stream',
        etag: 'etag',
        rangeHonored: true,
        bytesConsumed: 4096,
        abortedByByteBudget: false,
        error: undefined,
      }],
      skippedModelArtifactCount: 0,
      bytesConsumed: 4096,
      maximumBytes: 2 * 1024 * 1024,
      startedAt: '2026-09-03T08:00:00.000Z',
      finishedAt: '2026-09-03T08:00:01.000Z',
    },
    modelArtifactObservations: withObservation ? [observation] : [],
    modelArtifactObservationError: undefined,
    cacheBefore: { modelId: 'org/model', normalizedModelId: 'org/model', revisions: [] },
    cacheInspectionError: undefined,
  };
}

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  vi.clearAllMocks();
});

function mountModal() {
  return mount(DownloadVerificationModal, {
    global: {
      stubs: {
        Teleport: true,
      },
    },
  });
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('DownloadVerificationModal', () => {
  it('starts with full model download disabled and does not run until a model is entered', () => {
    const wrapper = mountModal();

    expect(wrapper.text()).toContain('Full model download');
    expect(wrapper.text()).toContain('Disabled');
    expect(wrapper.text()).toContain('Large model files are never downloaded in full');
    expect(wrapper.find<HTMLButtonElement>('[data-testid="download-verification-run"]').element.disabled).toBe(true);
    expect(collectDownloadVerificationEvidence).not.toHaveBeenCalled();
  });

  it('runs the shared bounded Download Evidence collector for the entered model', async () => {
    const collected = evidence();
    vi.mocked(collectDownloadVerificationEvidence).mockResolvedValue(collected);
    const wrapper = mountModal();

    await wrapper.find('[data-testid="download-verification-model-id"]').setValue('org/model');
    await wrapper.find('[data-testid="download-verification-run"]').trigger('click');

    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="download-verification-results"]').exists()).toBe(true);
      expect(wrapper.find<HTMLButtonElement>('[data-testid="download-verification-run"]').element.disabled).toBe(false);
    });
    expect(collectDownloadVerificationEvidence).toHaveBeenCalledWith({
      modelId: 'org/model',
      runId: expect.any(String),
      signal: expect.any(AbortSignal),
    });
    expect(wrapper.text()).toContain('org/model');
    expect(wrapper.text()).toContain('4.0 KiB');
    expect(wrapper.text()).toContain('https://cdn.example.test');
    expect(wrapper.get('[data-testid="download-verification-model-artifact-requests"]').text()).toContain('webgpu/q4');
    expect(wrapper.get('[data-testid="download-verification-model-artifact-requests"]').text()).toContain('onnx/model_q4.onnx');
    expect(wrapper.get('[data-testid="download-verification-probe-only-scope"]').text()).toContain('Runtime model loading, inference, and generation are not verified');
  });

  it('exports machine-readable probe evidence through the dedicated Evidence Worker', async () => {
    const collected = evidence();
    vi.mocked(collectDownloadVerificationEvidence).mockResolvedValue(collected);
    const dispose = vi.fn(async () => undefined);
    const createDownloadVerificationEvidence = vi.fn(async () => ({
      blob: new Blob(['evidence']),
      fileName: 'model-support-investigation-download-org-model-run.zip',
    }));
    vi.mocked(createModelSupportInvestigationEvidenceWorkerClient).mockReturnValue({
      createPartialEvidence: vi.fn(),
      createDownloadVerificationEvidence,
      dispose,
    });
    const createObjectURL = vi.fn(() => 'blob:evidence');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.isConnected).toBe(true);
      expect(this.download).toBe('model-support-investigation-download-org-model-run.zip');
    });

    const wrapper = mountModal();
    await wrapper.find('[data-testid="download-verification-model-id"]').setValue('org/model');
    await wrapper.find('[data-testid="download-verification-run"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[data-testid="download-verification-evidence-download"]').exists()).toBe(true));
    await wrapper.find('[data-testid="download-verification-evidence-download"]').trigger('click');

    await vi.waitFor(() => expect(createDownloadVerificationEvidence).toHaveBeenCalledTimes(1));
    expect(createDownloadVerificationEvidence).toHaveBeenCalledWith({
      evidence: expect.objectContaining({
        schemaVersion: 1,
        mode: 'probe-only',
        run: expect.objectContaining({ resolvedRevision: revision }),
        modelArtifactObservations: collected.modelArtifactObservations,
        cacheBefore: expect.objectContaining({ revisions: [] }),
      }),
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(document.querySelector('a[download="model-support-investigation-download-org-model-run.zip"]')).toBeNull();
    await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:evidence'));
    expect(dispose).toHaveBeenCalledTimes(1);

    click.mockRestore();
    vi.unstubAllGlobals();
  });

  it('does not download when Evidence resolves immediately before the modal is unmounted', async () => {
    const collected = evidence();
    vi.mocked(collectDownloadVerificationEvidence).mockResolvedValue(collected);
    const pending = Promise.withResolvers<{ blob: Blob; fileName: string }>();
    const createDownloadVerificationEvidence = vi.fn(() => pending.promise);
    const dispose = vi.fn(async () => undefined);
    vi.mocked(createModelSupportInvestigationEvidenceWorkerClient).mockReturnValue({
      createPartialEvidence: vi.fn(),
      createDownloadVerificationEvidence,
      dispose,
    });
    const createObjectURL = vi.fn(() => 'blob:late-settled-evidence');
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    const wrapper = mountModal();
    await wrapper.find('[data-testid="download-verification-model-id"]').setValue('org/model');
    await wrapper.find('[data-testid="download-verification-run"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[data-testid="download-verification-evidence-download"]').exists()).toBe(true));
    await wrapper.find('[data-testid="download-verification-evidence-download"]').trigger('click');
    await vi.waitFor(() => expect(createDownloadVerificationEvidence).toHaveBeenCalledTimes(1));

    // Settling queues the export continuation as a microtask. Unmount synchronously
    // before that continuation runs to reproduce the close-after-resolve race.
    pending.resolve({
      blob: new Blob(['evidence']),
      fileName: 'model-support-investigation-download-org-model-run.zip',
    });
    wrapper.unmount();
    await Promise.resolve();
    await Promise.resolve();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();

    click.mockRestore();
    vi.unstubAllGlobals();
  });

  it('disposes an in-flight Evidence export when the modal is unmounted and never downloads afterward', async () => {
    const collected = evidence();
    vi.mocked(collectDownloadVerificationEvidence).mockResolvedValue(collected);
    const pending = Promise.withResolvers<{ blob: Blob; fileName: string }>();
    const createDownloadVerificationEvidence = vi.fn(() => pending.promise);
    const dispose = vi.fn(async () => {
      pending.reject(new Error('Evidence export disposed'));
    });
    vi.mocked(createModelSupportInvestigationEvidenceWorkerClient).mockReturnValue({
      createPartialEvidence: vi.fn(),
      createDownloadVerificationEvidence,
      dispose,
    });
    const createObjectURL = vi.fn(() => 'blob:late-evidence');
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    const wrapper = mountModal();
    await wrapper.find('[data-testid="download-verification-model-id"]').setValue('org/model');
    await wrapper.find('[data-testid="download-verification-run"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[data-testid="download-verification-evidence-download"]').exists()).toBe(true));
    await wrapper.find('[data-testid="download-verification-evidence-download"]').trigger('click');
    await vi.waitFor(() => expect(createDownloadVerificationEvidence).toHaveBeenCalledTimes(1));

    wrapper.unmount();
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
    await Promise.resolve();

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();

    click.mockRestore();
    vi.unstubAllGlobals();
  });

  it('teleports the overlay to document.body, locks page scroll, and restores focus after closing', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    document.body.style.overflow = 'clip';

    const wrapper = mount(DownloadVerificationModal, { attachTo: document.body });
    await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"]')).toBe(document.activeElement));

    const modal = document.body.querySelector('[data-testid="download-verification-modal"]');
    const dialog = modal?.querySelector('[role="dialog"]');
    expect(modal).not.toBeNull();
    expect(modal?.parentElement).toBe(document.body);
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-labelledby')).toBe('download-verification-title');
    expect(document.body.style.overflow).toBe('hidden');

    wrapper.unmount();
    expect(document.body.style.overflow).toBe('clip');
    expect(document.activeElement).toBe(opener);
  });

  it('emits close from the dedicated close button', async () => {
    const wrapper = mountModal();
    await wrapper.find('[data-testid="download-verification-close"]').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });
});
