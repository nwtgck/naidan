import type { ImageDiagnosticListener } from '@/features/stable-diffusion-cpp-browser/diagnostics';
import type { WorkerProxy } from '@/utils/worker-transport';
import type { Request, Progress, WorkerResult, CancelControl, PreviewFrame, PreviewControl, PreviewSettings } from '@/features/stable-diffusion-cpp-browser/types';
export type Report = ({ event }: { event: Progress }) => void;
export interface ImageWorker {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink callbacks must be transferred as top-level arguments.
  generate(request: Request, report: WorkerProxy<Report>): Promise<WorkerResult>;
  cancel({ control }: { control: CancelControl }): void;
  updatePreview({ control }: { control: PreviewControl }): void;
}
export type ImageReleaseReason = 'explicit-release' | 'view-settings-changed' | 'retention-disabled' | 'context-key-changed' | 'forced-abort' | 'failed' | 'page-exit';
export interface ImageClient {
  generate({ request, signal, onProgress, onPreview, onDiagnostic }: { request: Request, signal: AbortSignal, onProgress: Report,
    onPreview?: ({ frame }: { frame: PreviewFrame }) => void, onDiagnostic?: ImageDiagnosticListener }): Promise<WorkerResult>;
  updatePreview({ settings }: { settings: PreviewSettings }): void;
  cancel(): void;
  release({ reason }?: { reason?: ImageReleaseReason }): void;
  dispose(): void;
}
export const TEST_ONLY = {
};
