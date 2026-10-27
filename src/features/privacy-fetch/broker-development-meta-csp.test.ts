import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrokerDevelopmentMetaCspNotForSecurity } from './broker-development-meta-csp';
import { PRIVACY_FETCH_PROTOCOL } from './protocol';
import { developmentMetaCspResultMessageSchema, developmentMetaCspSyncMessageSchema } from './development-meta-csp-protocol';

function message({ policies, sessionId, syncId }: { policies: string[], sessionId: string, syncId: string }) {
  return { protocol: PRIVACY_FETCH_PROTOCOL, type: 'development-meta-csp-sync' as const, policies, sessionId, syncId };
}

function createHarness() {
  const documentObject = document.implementation.createHTMLDocument();
  return { documentObject, broker: createBrokerDevelopmentMetaCspNotForSecurity({ documentObject }) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('broker development meta CSP native additions', () => {
  it('adds every raw policy synchronously and only appends the remaining verified prefix', () => {
    const { documentObject, broker } = createHarness();
    const first = "connect-src 'self'";
    const second = "img-src https://EXAMPLE.test; future-directive opaque";
    expect(broker.applySnapshot({ message: message({ policies: [first], sessionId: 'one', syncId: 'a' }) })).toMatchObject({ outcome: 'added', confirmedPolicyCount: 1 });
    const element = documentObject.head.querySelector('meta');
    expect(element?.httpEquiv).toBe('Content-Security-Policy');
    expect(element?.content).toBe(first);
    expect(element?.hasAttribute('data-naidan-developer-csp')).toBe(true);
    expect(broker.applySnapshot({ message: message({ policies: [first, second], sessionId: 'one', syncId: 'b' }) })).toMatchObject({ outcome: 'added', confirmedPolicyCount: 2 });
    expect([...documentObject.head.querySelectorAll('meta')].map(meta => meta.content)).toEqual([first, second]);
    expect(documentObject.head.querySelector('meta')).toBe(element);
    // A re-ready uses a new logical session but the same Document retains its
    // real additions. Confirm the identical history without duplicating metas.
    expect(broker.applySnapshot({ message: message({ policies: [first, second], sessionId: 'two', syncId: 'c' }) })).toMatchObject({ sessionId: 'two', syncId: 'c', outcome: 'added', confirmedPolicyCount: 2 });
    expect(documentObject.head.querySelectorAll('meta')).toHaveLength(2);
  });

  it('does not substitute, shorten, or skip a confirmed prefix', () => {
    const { documentObject, broker } = createHarness();
    broker.applySnapshot({ message: message({ policies: ['A', 'B'], sessionId: 'one', syncId: 'a' }) });
    for (const policies of [['A'], ['A', 'different', 'C'], ['B', 'A', 'C']]) {
      expect(broker.applySnapshot({ message: message({ policies, sessionId: 'one', syncId: 'b' }) })).toMatchObject({ outcome: 'unavailable', confirmedPolicyCount: 2 });
    }
    expect([...documentObject.head.querySelectorAll('meta')].map(meta => meta.content)).toEqual(['A', 'B']);
  });

  it('stops at the first append failure and retries that position from the next full snapshot', () => {
    const { documentObject, broker } = createHarness();
    const nativeAppend = documentObject.head.append.bind(documentObject.head);
    const append = vi.spyOn(documentObject.head, 'append');
    append.mockImplementationOnce(nativeAppend).mockImplementationOnce(() => {
      throw new Error('DOM failed');
    });
    expect(broker.applySnapshot({ message: message({ policies: ['A', 'B', 'C'], sessionId: 'one', syncId: 'a' }) })).toMatchObject({ outcome: 'partly-added', confirmedPolicyCount: 1 });
    expect(append).toHaveBeenCalledTimes(2);
    expect([...documentObject.head.querySelectorAll('meta')].map(meta => meta.content)).toEqual(['A']);
    append.mockImplementation(nativeAppend);
    expect(broker.applySnapshot({ message: message({ policies: ['A', 'B', 'C'], sessionId: 'one', syncId: 'b' }) })).toMatchObject({ outcome: 'added', confirmedPolicyCount: 3 });
    expect([...documentObject.head.querySelectorAll('meta')].map(meta => meta.content)).toEqual(['A', 'B', 'C']);
  });

  it('records an append that throws after attachment, without jumping to a later policy', () => {
    const { documentObject, broker } = createHarness();
    const nativeAppend = documentObject.head.append.bind(documentObject.head);
    vi.spyOn(documentObject.head, 'append').mockImplementationOnce((...nodes) => {
      nativeAppend(...nodes);
      throw new Error('failed after append');
    });
    expect(broker.applySnapshot({ message: message({ policies: ['A', 'B'], sessionId: 'one', syncId: 'a' }) })).toMatchObject({ outcome: 'partly-added', confirmedPolicyCount: 1 });
    expect([...documentObject.head.querySelectorAll('meta')].map(meta => meta.content)).toEqual(['A']);
    expect(broker.applySnapshot({ message: message({ policies: ['A', 'B'], sessionId: 'one', syncId: 'b' }) })).toMatchObject({ outcome: 'added', confirmedPolicyCount: 2 });
    expect([...documentObject.head.querySelectorAll('meta')].map(meta => meta.content)).toEqual(['A', 'B']);
  });

  it('cannot confirm an ambiguous DOM outcome on a later snapshot', () => {
    const { documentObject, broker } = createHarness();
    const createElement = documentObject.createElement.bind(documentObject);
    vi.spyOn(documentObject, 'createElement').mockImplementation((...args) => {
      const element = createElement(...args);
      Object.defineProperty(element, 'parentNode', {
        get: () => {
          throw new Error('unreadable parent');
        },
      });
      return element;
    });
    const append = vi.spyOn(documentObject.head, 'append').mockImplementationOnce(() => {
      throw new Error('unknown outcome');
    });
    expect(broker.applySnapshot({ message: message({ policies: ['A'], sessionId: 'one', syncId: 'a' }) })).toMatchObject({ outcome: 'unavailable', confirmedPolicyCount: 0 });
    expect(broker.applySnapshot({ message: message({ policies: ['A'], sessionId: 'one', syncId: 'b' }) })).toMatchObject({ outcome: 'unavailable', confirmedPolicyCount: 0 });
    expect(append).toHaveBeenCalledOnce();
  });

  it('does not couple raw native history to the diagnostic parser size limit', () => {
    const { documentObject, broker } = createHarness();
    const policy = `future-directive ${'x'.repeat(70_000)}`;
    expect(broker.applySnapshot({ message: message({ policies: [policy], sessionId: 'one', syncId: 'a' }) })).toMatchObject({ outcome: 'added', confirmedPolicyCount: 1 });
    expect(documentObject.head.querySelector('meta')?.content).toBe(policy);
  });

  it('leaves an empty document untouched when there are no policies', () => {
    const { documentObject, broker } = createHarness();
    expect(broker.applySnapshot({ message: message({ policies: [], sessionId: 'one', syncId: 'a' }) })).toMatchObject({ outcome: 'added', confirmedPolicyCount: 0 });
    expect(documentObject.head.querySelector('meta')).toBeNull();
  });
});

describe('development meta CSP control schemas', () => {
  it('validates raw snapshot and count-only confirmation without an AST budget', () => {
    const value = message({ policies: ['x'.repeat(70_000)], sessionId: 'one', syncId: 'a' });
    expect(developmentMetaCspSyncMessageSchema.parse(value)).toEqual(value);
    expect(developmentMetaCspResultMessageSchema.parse({ protocol: PRIVACY_FETCH_PROTOCOL, type: 'development-meta-csp-result', sessionId: 'one', syncId: 'a', outcome: 'partly-added', confirmedPolicyCount: 1 })).toMatchObject({ confirmedPolicyCount: 1 });
  });

  it.each([
    { policies: ['A', 1] },
    { sessionId: '' },
    { syncId: 1 },
    { type: 'request' },
    { unexpected: true },
  ])('rejects malformed raw control messages: %s', fields => {
    expect(developmentMetaCspSyncMessageSchema.safeParse({ ...message({ policies: ['A'], sessionId: 'one', syncId: 'a' }), ...fields }).success).toBe(false);
  });

  it.each([-1, 1.5, Number.POSITIVE_INFINITY])('rejects invalid confirmation count: %s', confirmedPolicyCount => {
    expect(developmentMetaCspResultMessageSchema.safeParse({ protocol: PRIVACY_FETCH_PROTOCOL, type: 'development-meta-csp-result', sessionId: 'one', syncId: 'a', outcome: 'added', confirmedPolicyCount }).success).toBe(false);
  });
});
