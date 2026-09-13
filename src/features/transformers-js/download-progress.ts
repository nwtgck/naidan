import { z } from 'zod';
import type { ProgressInfo, TransformersJsProductionInvestigationCandidate } from './types';

export type DownloadPhase = 'resolving-revision' | 'checking-cache' | 'preparing-metadata' | 'observing-candidate' | 'transferring' | 'saving' | 'checking-runtime' | 'complete' | 'failed';
export type DownloadFileStatus = 'queued' | 'transferring' | 'saving' | 'cached' | 'complete' | 'failed';
export interface DownloadFileProgress {
  path: string,
  status: DownloadFileStatus,
  loaded: number,
  total: number | undefined,
  progress: number | undefined,
}
export interface DownloadProgressSnapshot {
  phase: DownloadPhase,
  /** Milestone/work estimate, never a percentage of elapsed time or all downloads. */
  overallProgress: number,
  attemptNumber: number | undefined,
  attemptCount: number,
  candidate: TransformersJsProductionInvestigationCandidate | undefined,
  files: readonly DownloadFileProgress[],
  receivedBytes: number,
  cachedBytes: number,
  knownTotalBytes: number,
  unknownTotalCount: number,
}
export type DownloadProgressEvent =
  | { kind: 'phase'; phase: DownloadPhase }
  | { kind: 'metadata'; stage: string }
  | { kind: 'candidate'; candidate: TransformersJsProductionInvestigationCandidate; index: number; count: number }
  | { kind: 'plan'; index: number; paths: readonly string[] }
  | { kind: 'file'; index: number; info: ProgressInfo }
  | { kind: 'acceptance'; index: number };
export type DownloadProgressCallback = ({ event }: { event: DownloadProgressEvent }) => void;

/** Download observers are advisory. Do not use this for inference/tool callbacks. */
export function observeDownloadSafely({ observe }: { observe: (() => unknown) | undefined }): void {
  if (observe === undefined) return;
  try {
    void Promise.resolve(observe()).catch(() => undefined);
  } catch {
    // Rendering/telemetry must never turn successful resource I/O into a failure.
  }
}

export function publishDownloadProgress({ callback, event }: { callback: DownloadProgressCallback | undefined; event: DownloadProgressEvent }): void {
  // Do not let an observer mutate the candidate or required paths which the
  // orchestrator will subsequently use as acquisition authority.
  const snapshot = (() => {
    switch (event.kind) {
    case 'candidate': return { ...event, candidate: { ...event.candidate } };
    case 'plan': return { ...event, paths: [...event.paths] };
    case 'file': return { ...event, info: { ...event.info } };
    case 'phase': case 'metadata': case 'acceptance': return { ...event };
    default: { const exhaustive: never = event; throw new Error(String(exhaustive)); }
    }
  })();
  observeDownloadSafely({ observe: callback === undefined ? undefined : () => callback({ event: snapshot }) });
}

// Only the dedicated prefetch client consumes this wire shape. Raw Load progress
// retains its existing contract and cannot masquerade as network transfer here.
export const downloadTransferProgressSchema = z.object({
  status: z.enum(['queued', 'download', 'progress', 'saving', 'done', 'cached', 'error']),
  file: z.string().min(1),
  loaded: z.number().finite().nonnegative().optional(),
  total: z.number().finite().nonnegative().optional(),
  progress: z.number().finite().nonnegative().optional(),
}).strict();

export const downloadFailedTransferObservationSchema = z.object({
  receivedBytes: z.number().finite().nonnegative(),
  expectedBytes: z.number().finite().nonnegative().optional(),
}).strict();

/** Display identity only; it never authorizes or changes a requested URL. */
export function downloadResourcePath({ url }: { url: string }): string | undefined {
  try {
    const parts = new URL(url).pathname.split('/');
    if (parts[3] !== 'resolve' || !parts[1] || !parts[2] || !parts[4]) return undefined;
    const path = parts.slice(5).map(part => decodeURIComponent(part)).join('/');
    return path || undefined;
  } catch {
    return undefined;
  }
}

export function createDownloadProgressTracker() {
  let phase: DownloadPhase = 'resolving-revision';
  let overall = 0;
  let index: number | undefined;
  let count = 0;
  let candidate: TransformersJsProductionInvestigationCandidate | undefined;
  let files = new Map<string, DownloadFileProgress>();

  function advance({ value }: { value: number }): void {
    overall = Math.max(overall, Math.min(99, value));
  }
  function updateTransfer(): void {
    if (index === undefined || count === 0) return;
    const rows = [...files.values()];
    const known = rows.length > 0 && rows.every(row => row.total !== undefined && row.total > 0);
    const fraction = known
      ? rows.reduce((sum, row) => sum + Math.min(row.loaded, row.total!), 0) / rows.reduce((sum, row) => sum + row.total!, 0)
      : rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + (
        row.status === 'complete' || row.status === 'cached' ? 1 : row.total === undefined || row.total === 0 ? 0 : Math.min(1, row.loaded / row.total)
      ), 0) / rows.length;
    const slot = 85 / count;
    // Candidate slots reserve work for fallback, not bytes of unrequested models.
    // Unknown sizes use equal-file work units; known sizes use available bytes.
    // Keep only this overall estimate monotonic when those meanings switch.
    advance({ value: 10 + slot * index + slot * (0.1 + 0.7 * fraction) });
  }

  return {
    observe({ event }: { event: DownloadProgressEvent }): void {
      if (phase === 'complete' || phase === 'failed') return;
      switch (event.kind) {
      case 'phase': {
        phase = event.phase;
        switch (event.phase) {
        case 'resolving-revision': break;
        case 'checking-cache': advance({ value: 3 }); break;
        case 'preparing-metadata': advance({ value: 5 }); break;
        case 'complete': overall = 100; break; // Accepted: all unneeded fallback slots are skipped.
        case 'failed': break;
        case 'observing-candidate':
        case 'transferring':
        case 'saving':
        case 'checking-runtime': break;
        default: { const exhaustive: never = event.phase; throw new Error(String(exhaustive)); }
        }
        break;
      }
      case 'metadata': {
        if (index !== undefined) return;
        const milestones: Record<string, number> = { configuration: 5, 'resource-selection': 6, processor: 7, tokenizer: 7, 'storage-finalization': 9, complete: 10 };
        const value = milestones[event.stage];
        if (value !== undefined) advance({ value });
        break;
      }
      case 'candidate':
        if (!Number.isInteger(event.index) || !Number.isInteger(event.count) || event.count <= 0 || event.index < 0 || event.index >= event.count || index !== undefined && event.index <= index) return;
        index = event.index;
        count = event.count;
        candidate = { ...event.candidate };
        files = new Map();
        phase = 'observing-candidate';
        advance({ value: 10 + 85 * index / count });
        break;
      case 'plan':
        if (event.index !== index) return;
        files = new Map(event.paths.map(path => [path, { path, status: 'queued', loaded: 0, total: undefined, progress: undefined }]));
        phase = 'transferring';
        updateTransfer();
        break;
      case 'file': {
        if (event.index !== index) return;
        const parsed = downloadTransferProgressSchema.safeParse(event.info);
        if (!parsed.success) return;
        const info = parsed.data;
        const previous = files.get(info.file);
        if (previous === undefined || previous.status === 'complete' || previous.status === 'cached' || previous.status === 'failed') return;
        if (previous.status === 'saving' && (info.status === 'queued' || info.status === 'download' || info.status === 'progress')) return;
        if ((info.status === 'done' || info.status === 'cached') && !(info.loaded !== undefined && info.loaded > 0)) return;
        const loaded = info.loaded ?? previous.loaded;
        const total = info.total ?? previous.total;
        const status: DownloadFileStatus = (() => {
          switch (info.status) {
          case 'queued': return 'queued';
          case 'download': case 'progress': return 'transferring';
          case 'saving': return 'saving';
          case 'done': return 'complete';
          case 'cached': return 'cached';
          case 'error': return 'failed';
          default: { const exhaustive: never = info.status; throw new Error(String(exhaustive)); }
          }
        })();
        const progress = total === undefined || total === 0 ? undefined : Math.min(100, 100 * loaded / total);
        files.set(info.file, { path: info.file, status, loaded, total, progress });
        switch (phase) {
        case 'checking-runtime': break;
        case 'resolving-revision': case 'checking-cache': case 'preparing-metadata':
        case 'observing-candidate': case 'transferring': case 'saving':
          switch (status) {
          case 'saving': phase = 'saving'; break;
          case 'queued': case 'transferring': case 'cached': case 'complete': case 'failed': phase = 'transferring'; break;
          default: { const exhaustive: never = status; throw new Error(String(exhaustive)); }
          }
          break;
        default: { const exhaustive: never = phase; throw new Error(String(exhaustive)); }
        }
        updateTransfer();
        break;
      }
      case 'acceptance':
        if (event.index !== index || count === 0) return;
        phase = 'checking-runtime';
        advance({ value: 10 + 85 / count * (event.index + 0.9) });
        break;
      default: { const exhaustive: never = event; throw new Error(String(exhaustive)); }
      }
    },
    snapshot(): DownloadProgressSnapshot {
      const rows = [...files.values()].map(row => ({ ...row }));
      let receivedBytes = 0;
      let cachedBytes = 0;
      for (const row of rows) {
        switch (row.status) {
        case 'cached': cachedBytes += row.loaded; break;
        case 'queued': case 'transferring': case 'saving': case 'complete': case 'failed': receivedBytes += row.loaded; break;
        default: { const exhaustive: never = row.status; throw new Error(String(exhaustive)); }
        }
      }
      return {
        phase, overallProgress: Math.floor(overall), attemptNumber: index === undefined ? undefined : index + 1,
        attemptCount: count, candidate: candidate === undefined ? undefined : { ...candidate }, files: rows,
        receivedBytes,
        cachedBytes,
        knownTotalBytes: rows.reduce((sum, row) => sum + (row.total ?? 0), 0),
        unknownTotalCount: rows.filter(row => row.total === undefined || row.total <= 0).length,
      };
    },
  };
}

export const TEST_ONLY = {
};
