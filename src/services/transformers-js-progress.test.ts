import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Comlink from 'comlink';

// Mock Worker class
class MockWorker {
  terminate = vi.fn();
  postMessage = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  constructor() {}
}

vi.stubGlobal('Worker', MockWorker);

// Mock Comlink
vi.mock('comlink', () => ({
  wrap: vi.fn(),
  proxy: vi.fn(x => x),
  expose: vi.fn(),
}));

describe('transformersJsService progress logic', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    // Clear navigator mock
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn().mockRejectedValue(new Error('No storage'))
      }
    });
  });

  it('should cap metadata progress at 5%', async () => {
    const mockRemote = {
      loadModel: vi.fn().mockImplementation(async (_id, cb) => {
        // Send multiple small metadata files
        cb({ status: 'initiate', name: 'config.json' });
        cb({ status: 'progress', name: 'config.json', loaded: 1000, total: 1000 });
        cb({ status: 'done', name: 'config.json', loaded: 1000, total: 1000 });

        cb({ status: 'initiate', name: 'tokenizer.json' });
        cb({ status: 'progress', name: 'tokenizer.json', loaded: 50000, total: 50000 });
        cb({ status: 'done', name: 'tokenizer.json', loaded: 50000, total: 50000 });

        return { device: 'wasm' };
      })
    };
    (Comlink.wrap as any).mockReturnValue(mockRemote);

    const { transformersJsService } = await import('./transformers-js');

    let lastProgress = 0;
    transformersJsService.subscribe((_status, progress) => {
      lastProgress = progress;
    });

    await transformersJsService.loadModel('some-model');

    // Even though both files are 100% done, overall progress should be capped because no "heavy" file was seen
    expect(lastProgress).toBeLessThanOrEqual(5);
  });

  it('should stay in discovery phase (max 15%) for 3 seconds after heavy file seen', async () => {
    vi.useFakeTimers();

    const mockRemote = {
      loadModel: vi.fn().mockImplementation(async (_id, cb) => {
        // Metadata
        cb({ status: 'done', name: 'config.json', loaded: 1000, total: 1000 });

        // Heavy file starts
        cb({ status: 'initiate', name: 'model.onnx' });
        cb({ status: 'progress', name: 'model.onnx', loaded: 50000000, total: 100000000 }); // 50MB of 100MB (50%)

        return { device: 'wasm' };
      })
    };
    (Comlink.wrap as any).mockReturnValue(mockRemote);

    const { transformersJsService } = await import('./transformers-js');

    let lastProgress = 0;
    transformersJsService.subscribe((_status, progress) => {
      lastProgress = progress;
    });

    await transformersJsService.loadModel('some-model');

    // model.onnx is 50% done (50MB), but total recognized is < 100MB and time is < 3s
    // So discovery phase cap (15%) applies.
    expect(lastProgress).toBeLessThanOrEqual(15);

    vi.useRealTimers();
  });

  it('should transition to active download phase after 3 seconds', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const mockRemote = {
      loadModel: vi.fn().mockImplementation(async (_id, cb) => {
        const floor = 200 * 1024 * 1024;
        const half = 100 * 1024 * 1024;

        // Initial heavy file
        cb({ status: 'initiate', name: 'model.onnx' });
        cb({ status: 'progress', name: 'model.onnx', loaded: half, total: floor / 2 });

        // Fast forward time by 4 seconds
        vi.setSystemTime(now + 4000);

        // Trigger another update to recalculate
        cb({ status: 'progress', name: 'model.onnx', loaded: half + 1, total: floor / 2 });

        return { device: 'wasm' };
      })
    };
    (Comlink.wrap as any).mockReturnValue(mockRemote);

    const { transformersJsService } = await import('./transformers-js');

    let lastProgress = 0;
    transformersJsService.subscribe((_status, progress) => {
      lastProgress = progress;
    });

    await transformersJsService.loadModel('some-model');

    // Now Phase 3 applies. totalSize is 100MiB, but effectiveTotalSize has 200MiB floor.
    // (100MiB + 1) / 200MiB = ~50%
    expect(lastProgress).toBeGreaterThan(15);
    expect(lastProgress).toBe(50);

    vi.useRealTimers();
  });

  it('should ensure monotonicity (progress never goes backwards)', async () => {
    const mockRemote = {
      loadModel: vi.fn().mockImplementation(async (_id, cb) => {
        // High progress with small denominator
        cb({ status: 'initiate', name: 'file1.bin' });
        cb({ status: 'progress', name: 'file1.bin', loaded: 80, total: 100 }); // 80%? No, capped/floored.

        // Actually, let's trigger Phase 3
        const startTime = Date.now();
        vi.stubGlobal('Date', { now: () => startTime + 5000 }); // Force Phase 3

        cb({ status: 'initiate', name: 'heavy.bin' });
        cb({ status: 'progress', name: 'heavy.bin', loaded: 100000000, total: 200000000 }); // 50% (of 200MB floor)

        // Suddenly a NEW huge shard appears, increasing denominator
        cb({ status: 'initiate', name: 'huge_shard.bin' });
        cb({ status: 'progress', name: 'huge_shard.bin', loaded: 0, total: 1000000000 }); // Denominator becomes 1.2GB

        // (100MB / 1.2GB) is ~8%, which is less than 50%

        return { device: 'wasm' };
      })
    };
    (Comlink.wrap as any).mockReturnValue(mockRemote);

    const { transformersJsService } = await import('./transformers-js');

    const progressHistory: number[] = [];
    transformersJsService.subscribe((_status, progress) => {
      progressHistory.push(progress);
    });

    await transformersJsService.loadModel('some-model');

    // Check that history never decreases
    for (let i = 1; i < progressHistory.length; i++) {
      const current = progressHistory[i]!;
      const previous = progressHistory[i - 1]!;
      expect(current).toBeGreaterThanOrEqual(previous);
    }
  });

  it('should never reach 100% progress until model is ready', async () => {
    const mockRemote = {
      loadModel: vi.fn().mockImplementation(async (_id, cb) => {
        const startTime = Date.now();
        vi.stubGlobal('Date', { now: () => startTime + 5000 }); // Force Phase 3

        cb({ status: 'done', name: 'model.onnx', loaded: 1000000000, total: 1000000000 });

        return { device: 'wasm' };
      })
    };
    (Comlink.wrap as any).mockReturnValue(mockRemote);

    const { transformersJsService } = await import('./transformers-js');

    let lastProgress = 0;
    transformersJsService.subscribe((status, progress) => {
      if (status === 'loading') {
        lastProgress = progress;
      }
    });

    await transformersJsService.loadModel('some-model');

    expect(lastProgress).toBe(99);
    expect(transformersJsService.getState().status).toBe('ready');
  });
});
