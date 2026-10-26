import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCsp } from '@/utils/csp';
import { createDevelopmentMetaCspOwnerNotForSecurity } from './owner';

afterEach(() => {
  document.head.querySelectorAll('[data-naidan-developer-csp], #unrelated-development-meta-test').forEach(element => element.remove());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture({ loadParser }: { loadParser(): Promise<typeof parseCsp | undefined> }) {
  return createDevelopmentMetaCspOwnerNotForSecurity({ environment: { document, loadParser } });
}

describe('late native meta for development, never security', () => {
  it('does nothing for undefined or an empty saved value without loading a parser', async () => {
    const loadParser = vi.fn().mockResolvedValue(parseCsp);
    const owner = fixture({ loadParser });
    for (const serialized of [undefined, '', '  ']) {
      await owner.addForDevelopmentNotForSecurity({ serialized, source: 'saved-setting', isCurrent: () => true, isRecoveryResident: () => true });
    }
    expect(loadParser).not.toHaveBeenCalled();
    expect(owner.getSnapshot()).toMatchObject({ preparation: 'idle', installation: { kind: 'not-added' } });
    expect(document.head.querySelector('[data-naidan-developer-csp]')).toBeNull();
  });

  it('cannot apply a restrictive saved value before recovery controls are resident', async () => {
    const loadParser = vi.fn().mockResolvedValue(parseCsp);
    const owner = fixture({ loadParser });
    await owner.addForDevelopmentNotForSecurity({ serialized: "default-src 'none'", source: 'saved-setting', isCurrent: () => true, isRecoveryResident: () => false });
    expect(loadParser).not.toHaveBeenCalled();
    expect(owner.getSnapshot()).toMatchObject({ preparation: 'unavailable', reason: 'recovery-not-resident', installation: { kind: 'not-added' } });
    expect(document.head.querySelector('[data-naidan-developer-csp]')).toBeNull();
  });

  it('does not record empty members of a serialized header list as actual additions', async () => {
    const owner = fixture({ loadParser: async () => parseCsp });
    await owner.addForDevelopmentNotForSecurity({ serialized: ', ,', source: 'developer-action', isCurrent: () => true, isRecoveryResident: () => true });
    expect(owner.getSnapshot().additions).toEqual([]);
    expect(owner.getSnapshot().installation.kind).toBe('not-added');
    expect(owner.getAppliedForDocumentMessagesOnly()).toEqual([]);
  });

  it('rejects oversized restored whitespace before trimming or loading optional modules', async () => {
    const serialized = ' '.repeat(65_537);
    const originalTrim = String.prototype.trim;
    vi.spyOn(String.prototype, 'trim').mockImplementation(function (this: string) {
      if (String(this) === serialized) {
        throw new Error('Oversized policies must not be scanned before rejection.');
      }
      return originalTrim.call(this);
    });
    const loadParser = vi.fn().mockResolvedValue(parseCsp);
    const owner = fixture({ loadParser });
    await owner.addForDevelopmentNotForSecurity({ serialized, source: 'saved-setting', isCurrent: () => true, isRecoveryResident: () => true });
    expect(owner.getSnapshot()).toMatchObject({ reason: 'invalid-policy', installation: { kind: 'not-added' } });
    expect(loadParser).not.toHaveBeenCalled();
  });

  it.each(['recovery', 'storage'] as const)('rechecks %s after optional imports settle', async lost => {
    let ready = true;
    let current = true;
    let resolveParser: ((parser: typeof parseCsp) => void) | undefined;
    const loading = new Promise<typeof parseCsp>(resolve => {
      resolveParser = resolve;
    });
    const owner = fixture({ loadParser: () => loading });
    const pending = owner.addForDevelopmentNotForSecurity({ serialized: "script-src 'none'", source: 'saved-setting', isCurrent: () => current, isRecoveryResident: () => ready });
    await Promise.resolve();
    switch (lost) {
    case 'recovery': ready = false;
      break;
    case 'storage': current = false;
      break;
    default: {
      const exhaustive: never = lost;
      throw exhaustive;
    }
    }
    resolveParser?.(parseCsp);
    await pending;
    expect(document.head.querySelector('[data-naidan-developer-csp]')).toBeNull();
    expect(owner.getAppliedForDocumentMessagesOnly()).toEqual([]);
  });

  it('serializes new additions while preserving raw segments, cached ASTs, and unrelated meta', async () => {
    const unrelated = document.createElement('meta');
    unrelated.id = 'unrelated-development-meta-test';
    unrelated.httpEquiv = 'Content-Security-Policy';
    unrelated.content = "img-src 'self'";
    document.head.append(unrelated);
    const parser = vi.fn(parseCsp);
    const loadParser = vi.fn().mockResolvedValue(parser);
    const owner = fixture({ loadParser });
    const serialized = "connect-src 'self', img-src 'none'";
    const first = owner.addForDevelopmentNotForSecurity({ serialized, source: 'saved-setting', isCurrent: () => true, isRecoveryResident: () => true });
    const second = owner.addForDevelopmentNotForSecurity({ serialized: "default-src 'none'", source: 'developer-action', isCurrent: () => true, isRecoveryResident: () => true });
    expect(second).not.toBe(first);
    await second;
    const cached = owner.getAppliedForDocumentMessagesOnly()?.[0]?.parsed;
    await owner.addForDevelopmentNotForSecurity({ serialized, source: 'developer-action', isCurrent: () => true, isRecoveryResident: () => true });
    const metas = [...document.head.querySelectorAll<HTMLMetaElement>('[data-naidan-developer-csp]')];
    expect(metas.map(meta => meta.content)).toEqual(["connect-src 'self'", " img-src 'none'", "default-src 'none'"]);
    expect(owner.getSnapshot()).toMatchObject({ preparation: 'ready', additions: [{ serialized, source: 'saved-setting' }, { serialized: "default-src 'none'", source: 'developer-action' }] });
    expect(owner.getAppliedForDocumentMessagesOnly()?.[0]?.serialized).toBe(serialized);
    expect(owner.getAppliedForDocumentMessagesOnly()?.[0]?.parsed).toBe(cached);
    expect(unrelated.content).toBe("img-src 'self'");
    expect(loadParser).toHaveBeenCalledOnce();
    expect(parser).toHaveBeenCalledTimes(2);
  });

  it('finishes a stuck import at its own deadline and ignores late success', async () => {
    vi.useFakeTimers();
    let resolveParser: ((parser: typeof parseCsp) => void) | undefined;
    const loading = new Promise<typeof parseCsp>(resolve => {
      resolveParser = resolve;
    });
    const owner = fixture({ loadParser: () => loading });
    const pending = owner.addForDevelopmentNotForSecurity({ serialized: "default-src 'none'", source: 'saved-setting', isCurrent: () => true, isRecoveryResident: () => true });
    await vi.advanceTimersByTimeAsync(3_001);
    await pending;
    resolveParser?.(parseCsp);
    await Promise.resolve();
    expect(owner.getSnapshot()).toMatchObject({ preparation: 'unavailable', reason: 'parser-unavailable' });
    expect(document.head.querySelector('[data-naidan-developer-csp]')).toBeNull();
  });

  it.each(['missing', 'reject', 'parse-failed', 'parse-throws'] as const)('fails open for optional parser failure: %s', async failure => {
    const owner = fixture({
      async loadParser() {
        switch (failure) {
        case 'missing': return undefined;
        case 'reject': throw new Error('optional chunk blocked');
        case 'parse-failed': return () => ({ kind: 'failed', reason: 'too-many-tokens' });
        case 'parse-throws': return () => {
          throw new Error('optional parser failure');
        };
        default: {
          const exhaustive: never = failure;
          return exhaustive;
        }
        }
      },
    });
    await expect(owner.addForDevelopmentNotForSecurity({ serialized: "script-src 'none'", source: 'saved-setting', isCurrent: () => true, isRecoveryResident: () => true })).resolves.toBeUndefined();
    expect(owner.getSnapshot().installation.kind).toBe('not-added');
    expect(document.head.querySelector('[data-naidan-developer-csp]')).toBeNull();
  });

  it('retains the successful prefix after partial installation without retrying', async () => {
    const append = document.head.append.bind(document.head);
    const spy = vi.spyOn(document.head, 'append').mockImplementationOnce((...nodes) => append(...nodes)).mockImplementationOnce(() => {
      throw new Error('append failure');
    });
    const owner = fixture({ loadParser: async () => parseCsp });
    const serialized = "connect-src 'none', img-src 'none'";
    await owner.addForDevelopmentNotForSecurity({ serialized, source: 'saved-setting', isCurrent: () => true, isRecoveryResident: () => true });
    await owner.addForDevelopmentNotForSecurity({ serialized, source: 'saved-setting', isCurrent: () => true, isRecoveryResident: () => true });
    expect(owner.getSnapshot()).toMatchObject({ installation: { kind: 'partly-added', policies: ["connect-src 'none'"] } });
    expect(owner.getAppliedForDocumentMessagesOnly()?.[0]?.serialized).toBe("connect-src 'none'");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('caches only the latest deterministic parse failure without changing successful records', async () => {
    const parser = vi.fn<typeof parseCsp>().mockImplementation(({ serialized }) => serialized.startsWith('failure') ? { kind: 'failed', reason: 'too-many-tokens' } : parseCsp({ serialized }));
    const owner = fixture({ loadParser: async () => parser });
    const add = ({ serialized }: { serialized: string }) => owner.addForDevelopmentNotForSecurity({ serialized, source: 'developer-action', isCurrent: () => true, isRecoveryResident: () => true });
    await add({ serialized: "connect-src 'none'" });
    const cached = owner.getAppliedForDocumentMessagesOnly();
    await add({ serialized: 'failure-A' });
    await add({ serialized: 'failure-A' });
    expect(parser).toHaveBeenCalledTimes(2);
    expect(owner.getAppliedForDocumentMessagesOnly()).toBe(cached);
    await add({ serialized: "connect-src 'none'" });
    expect(owner.getSnapshot()).toMatchObject({ preparation: 'ready', reason: undefined, installation: { kind: 'added', serialized: "connect-src 'none'" } });
    expect(parser).toHaveBeenCalledTimes(2);
    await add({ serialized: 'failure-B' });
    await add({ serialized: 'failure-A' });
    expect(parser).toHaveBeenCalledTimes(4);
    expect(owner.getSnapshot().additions).toHaveLength(1);
  });

  it('records a local append that succeeded before its caller threw without scanning the DOM', async () => {
    const append = document.head.append.bind(document.head);
    vi.spyOn(document.head, 'append').mockImplementationOnce((...nodes) => append(...nodes)).mockImplementationOnce((...nodes) => {
      append(...nodes);
      throw new Error('after append');
    });
    const scan = vi.spyOn(document.head, 'querySelectorAll');
    const parser = vi.fn(parseCsp);
    const owner = fixture({ loadParser: async () => parser });
    await owner.addForDevelopmentNotForSecurity({ serialized: "connect-src 'none', img-src 'none'", source: 'developer-action', isCurrent: () => true, isRecoveryResident: () => true });
    expect(owner.getSnapshot().additions[0]?.policies).toEqual(["connect-src 'none'", " img-src 'none'"]);
    expect(owner.getAppliedForDocumentMessagesOnly()?.[0]?.parsed.policies).toHaveLength(2);
    expect(parser).toHaveBeenCalledOnce();
    expect(scan).not.toHaveBeenCalled();
  });

  it('keeps all raw managed additions after the diagnostic budget is exhausted', async () => {
    const parser = vi.fn(parseCsp);
    const owner = fixture({ loadParser: async () => parser });
    for (let index = 0; index < 65; index++) {
      await owner.addForDevelopmentNotForSecurity({ serialized: `connect-src https://host-${index}.example`, source: 'developer-action', isCurrent: () => true, isRecoveryResident: () => true });
    }
    expect(owner.getSnapshot().diagnostics).toBe('unavailable');
    expect(owner.getSnapshot().additions).toHaveLength(65);
    expect(owner.getAppliedForDocumentMessagesOnly()).toBeUndefined();
    expect(parser).toHaveBeenCalledTimes(65);
    await owner.addForDevelopmentNotForSecurity({ serialized: 'connect-src https://host-0.example', source: 'developer-action', isCurrent: () => true, isRecoveryResident: () => true });
    expect(owner.getSnapshot().additions).toHaveLength(65);
    expect(parser).toHaveBeenCalledTimes(65);
  });
});
