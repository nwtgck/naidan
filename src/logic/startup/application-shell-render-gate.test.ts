import { describe, expect, it } from 'vitest';
import { createApplicationShellRenderGate } from './application-shell-render-gate';

describe('application shell render gate', () => {
  it('waits until the initial shell reports ready', async () => {
    const gate = createApplicationShellRenderGate();
    let completed = false;
    const waiting = gate.waitForInitialRender().then(() => {
      completed = true;
    });

    await Promise.resolve();
    expect(completed).toBe(false);

    gate.reportInitialRender();
    await waiting;
    expect(completed).toBe(true);
  });

  it('retains a render failure until startup begins waiting for it', async () => {
    const gate = createApplicationShellRenderGate();
    const error = new Error('route preparation failed');

    gate.reportInitialRenderFailure({ error });

    await expect(gate.waitForInitialRender()).rejects.toBe(error);
  });

  it('keeps the first settlement when duplicate signals arrive', async () => {
    const gate = createApplicationShellRenderGate();

    gate.reportInitialRender();
    gate.reportInitialRenderFailure({ error: new Error('late failure') });

    await expect(gate.waitForInitialRender()).resolves.toBeUndefined();
  });
});
