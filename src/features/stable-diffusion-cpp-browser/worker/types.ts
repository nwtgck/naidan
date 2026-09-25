import type { ImageDiagnosticListener } from '@/features/stable-diffusion-cpp-browser/diagnostics';
import type { WorkerProxy } from '@/utils/worker-transport';
import type { Request, Progress, Response } from '@/features/stable-diffusion-cpp-browser/types';
export type Report = ({ event }: { event: Progress }) => void;
export interface ImageWorker {
  // Positional callback is required: Comlink proxy transfer handlers run at the top level.
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink must serialize the proxied callback as a top-level argument.
  generate(request: Request, report: WorkerProxy<Report>): Promise<Response>;
}
export interface ImageClient {
  generate({ request, signal, onProgress }: { request: Request, signal: AbortSignal, onProgress: Report, onDiagnostic?: ImageDiagnosticListener }): Promise<Response>;
  dispose(): void;
}
export const TEST_ONLY = {
};
