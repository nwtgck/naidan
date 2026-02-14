import { describe, it, expect, vi } from 'vitest';
import { Semaphore } from './concurrency';

describe('Semaphore', () => {
  it('allows tasks up to maxConcurrency to run immediately', async () => {
    const semaphore = new Semaphore(2);
    let running = 0;

    const task = async () => {
      running++;
      await new Promise(resolve => setTimeout(resolve, 50));
      const current = running;
      running--;
      return current;
    };

    const p1 = semaphore.run(task);
    const p2 = semaphore.run(task);

    // Both should have started immediately (or almost immediately)
    // We check if they are running concurrently
    const results = await Promise.all([p1, p2]);
    expect(results).toContain(2); // At least one point where both were running
  });

  it('queues tasks when maxConcurrency is reached', async () => {
    const semaphore = new Semaphore(1);
    let activeCount = 0;
    let maxObservedActive = 0;
    const completedTasks: number[] = [];

    const task = async (id: number) => {
      activeCount++;
      maxObservedActive = Math.max(maxObservedActive, activeCount);
      await new Promise(resolve => setTimeout(resolve, 20));
      completedTasks.push(id);
      activeCount--;
    };

    const p1 = semaphore.run(() => task(1));
    const p2 = semaphore.run(() => task(2));
    const p3 = semaphore.run(() => task(3));

    await Promise.all([p1, p2, p3]);

    expect(maxObservedActive).toBe(1);
    expect(completedTasks).toEqual([1, 2, 3]); // Should execute in order
  });

  it('releases and executes the next task when one completes', async () => {
    const semaphore = new Semaphore(2);
    let activeCount = 0;

    const task = async () => {
      activeCount++;
      await new Promise(resolve => setTimeout(resolve, 50));
      activeCount--;
    };

    const p1 = semaphore.run(task);
    const p2 = semaphore.run(task);
    const p3 = semaphore.run(task);

    // Initial state: 2 running, 1 queued
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(activeCount).toBe(2);

    // Wait for first batch to finish
    await Promise.all([p1, p2]);

    // Now p3 should be running or finished
    expect(activeCount).toBeLessThanOrEqual(1);
    await p3;
    expect(activeCount).toBe(0);
  });

  it('handles rejections and still releases the semaphore', async () => {
    const semaphore = new Semaphore(1);

    const failingTask = async () => {
      throw new Error('Task failed');
    };

    const successTask = vi.fn().mockResolvedValue('success');

    // Run failing task
    await expect(semaphore.run(failingTask)).rejects.toThrow('Task failed');

    // The next task should still run because the semaphore was released
    const result = await semaphore.run(successTask);
    expect(result).toBe('success');
    expect(successTask).toHaveBeenCalled();
  });

  it('works correctly with acquire and release called manually', async () => {
    const semaphore = new Semaphore(1);
    let step = 0;

    const manualTask = async () => {
      await semaphore.acquire();
      step++;
      // Do nothing, wait for external signal
    };

    const p1 = manualTask();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(step).toBe(1);

    const p2 = manualTask();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(step).toBe(1); // p2 is waiting

    semaphore.release(); // Releases p1's slot (even though p1 didn't "finish", the count goes down)
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(step).toBe(2); // p2 now allowed to proceed

    semaphore.release(); // Cleanup
    await Promise.all([p1, p2]);
  });

  it('handles high volume of concurrent requests', async () => {
    const concurrencyLimit = 5;
    const totalTasks = 50;
    const semaphore = new Semaphore(concurrencyLimit);
    let activeCount = 0;
    let maxActive = 0;
    let totalCompleted = 0;

    const tasks = Array.from({ length: totalTasks }).map((_, i) => {
      return semaphore.run(async () => {
        activeCount++;
        maxActive = Math.max(maxActive, activeCount);
        await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
        activeCount--;
        totalCompleted++;
        return i;
      });
    });

    const results = await Promise.all(tasks);

    expect(results.length).toBe(totalTasks);
    expect(totalCompleted).toBe(totalTasks);
    expect(maxActive).toBeLessThanOrEqual(concurrencyLimit);
    expect(activeCount).toBe(0);
  });

  it('maintains FIFO order for queued tasks', async () => {
    const semaphore = new Semaphore(1);
    const order: number[] = [];

    const task = (id: number) => semaphore.run(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      order.push(id);
    });

    // Start one
    const p1 = task(1);
    // Queue others
    const p2 = task(2);
    const p3 = task(3);
    const p4 = task(4);

    await Promise.all([p1, p2, p3, p4]);
    expect(order).toEqual([1, 2, 3, 4]);
  });
});
