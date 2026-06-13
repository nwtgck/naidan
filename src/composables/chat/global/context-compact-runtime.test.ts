import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createContextCompactRuntime } from './context-compact-runtime';

describe('createContextCompactRuntime', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('clears completed progress after a short delay', async () => {
    vi.useFakeTimers();
    try {
      const runtime = createContextCompactRuntime();

      runtime.setProgress({
        chatId: 'chat-compact',
        progress: {
          phase: 'complete',
          requestPreview: undefined,
          outputPreview: '# Compact Context',
        },
      });

      expect(runtime.getProgress({ chatId: 'chat-compact' })).toEqual({
        phase: 'complete',
        requestPreview: undefined,
        outputPreview: '# Compact Context',
      });

      await vi.advanceTimersByTimeAsync(399);

      expect(runtime.getProgress({ chatId: 'chat-compact' })).toEqual({
        phase: 'complete',
        requestPreview: undefined,
        outputPreview: '# Compact Context',
      });

      await vi.advanceTimersByTimeAsync(1);

      expect(runtime.getProgress({ chatId: 'chat-compact' })).toEqual({
        phase: 'idle',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces the reset timer when a new progress update arrives', async () => {
    vi.useFakeTimers();
    try {
      const runtime = createContextCompactRuntime();

      runtime.setProgress({
        chatId: 'chat-compact',
        progress: {
          phase: 'complete',
          requestPreview: undefined,
          outputPreview: '# First',
        },
      });
      runtime.setProgress({
        chatId: 'chat-compact',
        progress: {
          phase: 'building_request',
          compactedMessageCount: 4,
          suffixMessageCount: 2,
          requestPreview: 'preview',
        },
      });

      await vi.advanceTimersByTimeAsync(400);

      expect(runtime.getProgress({ chatId: 'chat-compact' })).toEqual({
        phase: 'building_request',
        compactedMessageCount: 4,
        suffixMessageCount: 2,
        requestPreview: 'preview',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
