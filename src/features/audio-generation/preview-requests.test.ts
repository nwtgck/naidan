import { describe, expect, it, vi } from 'vitest';
import { createAudioPreviewRequests } from './preview-requests';

describe('per-generation repeatable preview requests', () => {
  it('retains queued intent, supports repeated requests and unsubscribes without affecting another generation', () => {
    const first = createAudioPreviewRequests(); const next = createAudioPreviewRequests();
    first.request(); expect(first.requests.version).toBe(1);
    const listener = vi.fn(); const unsubscribe = first.requests.subscribe({ listener });
    first.request(); first.request(); expect(listener).toHaveBeenCalledTimes(2);
    expect(first.requests.version).toBe(3); expect(next.requests.version).toBe(0);
    unsubscribe(); first.request(); expect(listener).toHaveBeenCalledTimes(2);
  });
});
