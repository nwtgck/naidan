import { z } from 'zod';
import type { ProgressInfo, TransformersJsProductionInvestigationCandidate } from './types';
import { createDownloadEtaEstimator } from './download-eta';

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
  overallProgress: number | undefined,
  estimateGeneration: number,
  revisionReason: 'size-updated' | 'size-conflict' | 'resource-restarted' | undefined,
  completedFileCount: number,
  totalFileCount: number,
  downloadEta: { status: 'estimating'; remainingSeconds: number; bytesPerSecond: number } | { status: 'unavailable' | 'warming-up' | 'stalled' },
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
  | { kind: 'sizes'; index: number; sizes: readonly { path: string; bytes: number }[] }
  | { kind: 'prefetch-complete'; index: number }
  | { kind: 'cached-acceptance' }
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
    case 'file': return { ...event, info: { ...event.info, ...event.info.downloadTiming === undefined ? {} : { downloadTiming: typeof event.info.downloadTiming === 'object' ? { ...event.info.downloadTiming } : event.info.downloadTiming } } };
    case 'sizes': return { ...event, sizes: event.sizes.map(size => ({ ...size })) };
    case 'phase': case 'metadata': case 'acceptance': case 'prefetch-complete': case 'cached-acceptance': return { ...event };
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
  downloadTotalKind: z.enum(['decoded-response', 'unverified-http']).optional(),
  downloadTiming: z.union([z.literal('unavailable'), z.object({ clockId: z.string().min(1), requestId: z.number().int().nonnegative(), sequence: z.number().int().positive(), observedAtMs: z.number().finite().nonnegative() }).strict()]).optional(),
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
  let overall: number | undefined = 0;
  let index: number | undefined;
  let count = 0;
  let candidate: TransformersJsProductionInvestigationCandidate | undefined;
  let files = new Map<string, DownloadFileProgress>();
  let estimateGeneration = 0;
  let revisionReason: DownloadProgressSnapshot['revisionReason'];
  let denominatorPublished = false;
  let prefetchComplete = false;
  let eta = createDownloadEtaEstimator({ now: () => performance.now() });
  const blockedHints = new Set<string>();
  const sequences = new Map<string, number>();

  function revise({ reason }: { reason: NonNullable<DownloadProgressSnapshot['revisionReason']> }): void {
    if (denominatorPublished) {
      estimateGeneration++; revisionReason = reason;
    }
  }

  function advance({ value }: { value: number }): void {
    overall = Math.min(100, value);
  }
  function updateTransfer(): void {
    if (index === undefined || count === 0) return;
    const rows = [...files.values()];
    if (rows.some(row => row.status === 'failed')) {
      overall = undefined; return;
    }
    if (prefetchComplete) {
      overall = 95; return;
    }
    const total = rows.reduce((sum, row) => sum + (row.total ?? 0), 0);
    const known = rows.length > 0 && Number.isSafeInteger(total) && total > 0 && rows.every(row => row.total !== undefined && row.total > 0);
    if (!known) {
      overall = undefined; return;
    }
    denominatorPublished = true;
    const filled = rows.reduce((sum, row) => {
      switch (row.status) {
      case 'queued': return sum;
      case 'transferring': case 'saving': case 'complete': case 'cached': case 'failed': return sum + Math.min(row.loaded, row.total!);
      default: { const exhaustive: never = row.status; throw new Error(String(exhaustive)); }
      }
    }, 0);
    // Current candidate only. Cached bytes and received bytes are disjoint;
    // copying staging data never adds bytes a second time. The last point is
    // reserved for the real prefetch result, not body EOF or a display timer.
    advance({ value: Math.min(94, 5 + 90 * filled / total) });
  }

  return {
    observe({ event }: { event: DownloadProgressEvent }): void {
      if (phase === 'complete' || phase === 'failed') return;
      switch (event.kind) {
      case 'phase': {
        phase = event.phase;
        switch (event.phase) {
        case 'resolving-revision': break;
        case 'checking-cache': advance({ value: 1 }); break;
        case 'preparing-metadata': advance({ value: 2 }); break;
        case 'complete': overall = 100; break;
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
        const milestones: Record<string, number> = { configuration: 2, 'resource-selection': 3, processor: 4, tokenizer: 4, 'storage-finalization': 4, complete: 5 };
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
        blockedHints.clear(); sequences.clear(); prefetchComplete = false;
        estimateGeneration = 0; revisionReason = undefined; denominatorPublished = false;
        eta = createDownloadEtaEstimator({ now: () => performance.now() });
        phase = 'observing-candidate';
        advance({ value: 5 });
        break;
      case 'plan':
        if (event.index !== index) return;
        files = new Map(event.paths.map(path => [path, { path, status: 'queued', loaded: 0, total: undefined, progress: undefined }]));
        phase = 'transferring';
        updateTransfer();
        break;
      case 'sizes':
        if (event.index !== index || prefetchComplete) return;
        for (const { path, bytes } of event.sizes) {
          const row = files.get(path);
          if (row === undefined || blockedHints.has(path) || row.status === 'complete' || row.status === 'cached' || row.status === 'failed') continue;
          if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes < row.loaded || row.total !== undefined && row.total !== bytes) {
            if (row.total !== undefined) revise({ reason: 'size-conflict' });
            blockedHints.add(path); files.set(path, { ...row, total: undefined, progress: undefined }); continue;
          }
          files.set(path, { ...row, total: bytes, progress: 100 * row.loaded / bytes });
        }
        updateTransfer();
        break;
      case 'prefetch-complete':
        if (event.index !== index || [...files.values()].some(row => row.status !== 'complete' && row.status !== 'cached')) return;
        prefetchComplete = true; updateTransfer(); break;
      case 'cached-acceptance':
        phase = 'checking-runtime'; overall = 95; break;
      case 'file': {
        if (event.index !== index) return;
        const parsed = downloadTransferProgressSchema.safeParse(event.info);
        if (!parsed.success) return;
        const info = parsed.data;
        const previous = files.get(info.file);
        if (previous === undefined || previous.status === 'complete' || previous.status === 'cached' || previous.status === 'failed') return;
        if (previous.status === 'saving' && (info.status === 'queued' || info.status === 'download' || info.status === 'progress')) return;
        if ((info.status === 'done' || info.status === 'cached') && !(info.loaded !== undefined && info.loaded > 0)) return;
        if (typeof info.downloadTiming === 'object') {
          const key = info.downloadTiming.clockId;
          if (info.downloadTiming.sequence <= (sequences.get(key) ?? 0)) return;
          sequences.set(key, info.downloadTiming.sequence);
        }
        let loaded = info.loaded ?? previous.loaded;
        let total = previous.total;
        const terminal = info.status === 'done' || info.status === 'cached';
        if (loaded < previous.loaded) {
          switch (info.status) {
          case 'download': revise({ reason: 'resource-restarted' }); break;
          case 'queued': case 'progress': case 'saving': case 'done': case 'cached': case 'error': return;
          default: { const exhaustive: never = info.status; throw new Error(String(exhaustive)); }
          }
        }
        switch (info.status) {
        case 'queued': loaded = 0; break;
        case 'download': case 'progress': case 'saving': case 'done': case 'cached': case 'error': break;
        default: { const exhaustive: never = info.status; throw new Error(String(exhaustive)); }
        }
        if (terminal) {
          if (total !== undefined && total !== loaded) revise({ reason: 'size-updated' });
          total = Number.isSafeInteger(loaded) ? loaded : undefined;
        } else if (info.downloadTotalKind === 'decoded-response' && info.total !== undefined && !blockedHints.has(info.file)) {
          if (total !== undefined && total !== info.total) {
            revise({ reason: 'size-conflict' }); blockedHints.add(info.file); total = undefined;
          } else total = Number.isSafeInteger(info.total) && info.total > 0 ? info.total : undefined;
        }
        if (total !== undefined && loaded > total) {
          revise({ reason: 'size-conflict' }); blockedHints.add(info.file); total = undefined;
        }
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
        eta.observe({ info });
        switch (phase) {
        case 'checking-runtime': break;
        case 'resolving-revision': case 'checking-cache': case 'preparing-metadata':
        case 'observing-candidate': case 'transferring': case 'saving':
          switch (status) {
          case 'saving': phase = 'saving'; break;
          case 'queued': case 'transferring': case 'cached': case 'complete': case 'failed':
            phase = [...files.values()].some(row => row.status === 'saving') ? 'saving' : 'transferring'; break;
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
        advance({ value: 95 });
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
      const total = rows.reduce((sum, row) => sum + (row.total ?? 0), 0);
      const known = rows.length > 0 && Number.isSafeInteger(total) && rows.every(row => row.total !== undefined && row.total > 0 && row.status !== 'failed');
      const remaining = known ? rows.reduce((sum, row) => sum + Math.max(0, row.total! - row.loaded), 0) : undefined;
      return {
        phase, overallProgress: overall === undefined ? undefined : Math.floor(overall), attemptNumber: index === undefined ? undefined : index + 1,
        estimateGeneration, revisionReason,
        completedFileCount: rows.filter(row => row.status === 'complete' || row.status === 'cached').length,
        totalFileCount: rows.length,
        downloadEta: eta.snapshot({ remainingBytes: remaining, active: phase === 'transferring' }),
        attemptCount: count, candidate: candidate === undefined ? undefined : { ...candidate }, files: rows,
        receivedBytes,
        cachedBytes,
        knownTotalBytes: Number.isSafeInteger(total) ? total : 0,
        unknownTotalCount: rows.filter(row => row.total === undefined || row.total <= 0).length,
      };
    },
  };
}

export const TEST_ONLY = {
};
