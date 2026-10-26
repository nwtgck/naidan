import { describe, expect, it } from 'vitest';
import { parseCsp } from '@/utils/csp';
import { describeCspAndDevelopmentMetaForUiMessagesOnly, describeCspObservationForUiMessagesOnly, summarizeCspConnectionsForDisplayOnly } from './messages';
import type { CspHintTarget, CspObservationSnapshot } from './types';

function observation({ serialized }: { serialized: string }): Extract<CspObservationSnapshot, { kind: 'observed' }> {
  const result = parseCsp({ serialized });
  if (result.kind === 'failed') {
    throw new Error('invalid fixture');
  }
  return { kind: 'observed', documentUrl: 'https://app.example/prefix/', enforce: { serialized, parsed: result.value }, reportOnly: undefined };
}

function hint({ serialized, target, broker }: { serialized: string, target: CspHintTarget, broker: 'hosted' | 'absent' }) {
  return describeCspObservationForUiMessagesOnly({ observation: observation({ serialized }), target, broker, budget: { remaining: 65_536 } });
}

describe('display-only CSP evidence', () => {
  it('describes an excluded endpoint while leaving loopback and self without a notice', () => {
    const serialized = "connect-src 'self' http://localhost:* http://127.0.0.1:*";
    expect(hint({ serialized, target: { kind: 'connection', endpoint: 'https://api.openai.com/v1', apiPath: '/models' }, broker: 'hosted' })).toMatchObject({ tone: 'caution', subject: 'connection', details: [{ directive: 'connect-src' }] });
    for (const endpoint of ['http://localhost:11434', 'https://localhost:11434']) {
      expect(hint({ serialized, target: { kind: 'connection', endpoint, apiPath: '/api/tags' }, broker: 'hosted' })).toBeUndefined();
    }
    expect(hint({ serialized, target: { kind: 'connection', endpoint: '', apiPath: '/api/tags' }, broker: 'hosted' })).toBeUndefined();
  });

  it('uses the provider string-append order before resolving query and fragment URLs', () => {
    const serialized = 'connect-src https://api.example/v1';
    for (const endpoint of ['https://api.example/v1?mode=demo', 'https://api.example/v1#fragment']) {
      expect(hint({ serialized, target: { kind: 'connection', endpoint, apiPath: '/models' }, broker: 'hosted' })).toBeUndefined();
    }
    expect(hint({ serialized, target: { kind: 'connection', endpoint: 'https://api.example/v1', apiPath: '/models' }, broker: 'hosted' })).toBeDefined();
  });

  it('does not turn an unknown expression into an exclusion', () => {
    expect(hint({ serialized: "connect-src 'future-allow-expression'", target: { kind: 'connection', endpoint: 'https://api.example', apiPath: '/models' }, broker: 'hosted' })).toBeUndefined();
  });

  it('keeps none, empty lists, absent directives, and mixed lists distinct', () => {
    const target: CspHintTarget = { kind: 'connection', endpoint: 'https://api.example', apiPath: '/models' };
    expect(hint({ serialized: 'connect-src', target, broker: 'hosted' })).toBeDefined();
    expect(hint({ serialized: "connect-src 'none'", target, broker: 'hosted' })).toBeDefined();
    expect(hint({ serialized: "img-src 'none'", target, broker: 'hosted' })).toBeUndefined();
    expect(hint({ serialized: "connect-src 'none' https://api.example", target, broker: 'hosted' })).toBeUndefined();
    const mixed = hint({ serialized: "connect-src 'none' http://localhost:*", target, broker: 'hosted' });
    expect(mixed?.details[0]?.sourceDescriptions).toEqual([{ kind: 'loopback' }]);
  });

  it('uses the first duplicate directive and intersects separate enforce policies', () => {
    const target: CspHintTarget = { kind: 'connection', endpoint: 'https://api.example', apiPath: '/models' };
    expect(hint({ serialized: "connect-src https://api.example; connect-src 'none'", target, broker: 'hosted' })).toBeUndefined();
    expect(hint({ serialized: "connect-src https://api.example, connect-src 'none'", target, broker: 'hosted' })).toBeDefined();
  });

  it('recognizes foreign-host self exclusions while retaining opaque bootstrap uncertainty', () => {
    const target: CspHintTarget = { kind: 'wikipedia' };
    const value = hint({ serialized: "connect-src 'self' http://localhost:*; frame-ancestors 'none'", target, broker: 'hosted' });
    expect(value?.details.map(detail => detail.directive)).toEqual(['connect-src', 'frame-ancestors']);
    expect(hint({ serialized: "connect-src 'self'; frame-ancestors 'self'", target, broker: 'hosted' })?.details.map(detail => detail.directive)).toEqual(['connect-src']);
    expect(hint({ serialized: "connect-src 'none'; frame-ancestors 'none'", target, broker: 'absent' })?.details.map(detail => detail.directive)).toEqual(['connect-src']);
  });

  it('does not extrapolate one allowed Wikipedia language to the entire group', () => {
    expect(hint({ serialized: 'connect-src https://ja.wikipedia.org', target: { kind: 'wikipedia' }, broker: 'absent' })).toBeUndefined();
    expect(hint({ serialized: 'connect-src https://*.wikipedia.org', target: { kind: 'wikipedia' }, broker: 'absent' })).toBeUndefined();
    expect(hint({ serialized: 'connect-src https://*.wikipedia.org.example.net', target: { kind: 'wikipedia' }, broker: 'absent' })).toBeDefined();
  });

  it.each([
    { source: 'https://*.hf.co', notice: 'absent' },
    { source: 'http://*.hf.co', notice: 'absent' },
    { source: 'https://*.hf.co:443', notice: 'absent' },
    { source: 'https://*.co', notice: 'absent' },
    { source: 'https:', notice: 'absent' },
    { source: '*', notice: 'absent' },
    { source: 'https://one.hf.co', notice: 'absent' },
    { source: 'https://*.narrow.hf.co', notice: 'absent' },
    { source: 'https://*.hf.co/specific/', notice: 'absent' },
    { source: "'future-source-expression'", notice: 'absent' },
    { source: 'https://hf.co', notice: 'present' },
    { source: 'https://*.hf.co:8443', notice: 'present' },
    { source: 'https://*.hf.co.example', notice: 'present' },
    { source: 'https://*.unrelated.example', notice: 'present' },
  ] as const)('matches the complete HTTPS HF subdomain family conservatively: $source', ({ source, notice }) => {
    const value = hint({ serialized: `connect-src https://huggingface.co ${source}`, target: { kind: 'huggingface-download' }, broker: 'hosted' });
    switch (notice) {
    case 'absent': expect(value).toBeUndefined();
      break;
    case 'present': expect(value?.details).toMatchObject([{ directive: 'connect-src', context: 'privacy-broker' }]);
      break;
    default: {
      const exhaustive: never = notice;
      throw exhaustive;
    }
    }
  });

  it('keeps the Hub required even when every delivery subdomain is permitted', () => {
    expect(hint({ serialized: 'connect-src https://*.hf.co', target: { kind: 'huggingface-download' }, broker: 'hosted' })?.details).toMatchObject([{ directive: 'connect-src', context: 'privacy-broker' }]);
  });

  it('separates broker script preparation from external connect permissions', () => {
    const value = hint({ serialized: "connect-src https://*.wikipedia.org; frame-ancestors 'self'; script-src 'none'", target: { kind: 'wikipedia' }, broker: 'hosted' });
    expect(value?.details.map(detail => detail.directive)).toEqual(['script-src']);
  });

  it('does not guess dynamic relay paths from the relay root', () => {
    expect(hint({ serialized: 'connect-src https://relay.example/allowed/', target: { kind: 'relay', url: 'https://relay.example' }, broker: 'hosted' })).toBeUndefined();
    expect(hint({ serialized: 'connect-src https://different.example/allowed/', target: { kind: 'relay', url: 'https://relay.example' }, broker: 'hosted' })).toBeDefined();
  });

  it('uses resource-specific fallback, and form-action has no default fallback', () => {
    const image: CspHintTarget = { kind: 'resource', url: 'https://image.example/x.png', destination: 'image', realm: 'document' };
    expect(hint({ serialized: "default-src 'none'; img-src https://image.example", target: image, broker: 'hosted' })).toBeUndefined();
    expect(hint({ serialized: "default-src 'none'", target: image, broker: 'hosted' })?.details[0]?.directive).toBe('default-src');
    const form: CspHintTarget = { kind: 'resource', url: 'https://app.example/submit', destination: 'form', realm: 'document' };
    expect(hint({ serialized: "default-src 'none'", target: form, broker: 'hosted' })).toBeUndefined();
    expect(hint({ serialized: "form-action 'none'", target: form, broker: 'hosted' })?.subject).toBe('form');
    expect(hint({ serialized: "script-src 'none'", target: { kind: 'resource', url: '/worker.js', destination: 'worker', realm: 'document' }, broker: 'hosted' })?.details[0]?.directive).toBe('script-src');
  });

  it('keeps CSS and font source constraints separate from connect-src', () => {
    expect(hint({ serialized: "connect-src *; style-src 'none'", target: { kind: 'resource', url: 'https://css.example/style.css', destination: 'style', realm: 'document' }, broker: 'hosted' })?.subject).toBe('style');
    expect(hint({ serialized: "connect-src *; font-src 'none'", target: { kind: 'resource', url: 'https://font.example/f.woff2', destination: 'font', realm: 'document' }, broker: 'hosted' })?.subject).toBe('font');
  });

  it('handles scheme upgrades, wildcard ports, domain boundaries, and decoded path segments', () => {
    const cases = [
      { source: 'http://api.example:*', url: 'https://api.example:8443/x' },
      { source: 'https://*.api.example', url: 'https://a.b.api.example/x' },
      { source: 'https://api.example/A%2FB/', url: 'https://api.example/A%2fB/x' },
    ];
    for (const { source, url } of cases) {
      expect(hint({ serialized: `img-src ${source}`, target: { kind: 'resource', url, destination: 'image', realm: 'document' }, broker: 'hosted' })).toBeUndefined();
    }
    expect(hint({ serialized: 'img-src https://*.api.example', target: { kind: 'resource', url: 'https://api.example/x', destination: 'image', realm: 'document' }, broker: 'hosted' })).toBeDefined();
  });

  it('aggregates a bounded list into one generic resource message', () => {
    const resource = { url: 'https://images.example/x', destination: 'image', realm: 'document' } as const;
    const value = hint({ serialized: "img-src 'none'", target: { kind: 'resource-list', resources: [resource, resource] }, broker: 'hosted' });
    expect(value?.subject).toBe('resource');
    expect(value?.details).toHaveLength(1);
    expect(hint({ serialized: "img-src 'none'", target: { kind: 'resource-list', resources: Array(17).fill(resource) }, broker: 'hosted' })).toBeUndefined();
  });

  it('does not use report-only, unavailable, or exhausted evidence as a warning', () => {
    const target: CspHintTarget = { kind: 'wikipedia' };
    const original = observation({ serialized: "connect-src 'none'" });
    if (original.kind !== 'observed') {
      throw new Error('invalid fixture');
    }
    expect(describeCspObservationForUiMessagesOnly({ observation: { ...original, enforce: undefined, reportOnly: original.enforce }, target, broker: 'hosted', budget: { remaining: 10 } })).toBeUndefined();
    expect(describeCspObservationForUiMessagesOnly({ observation: { kind: 'unavailable', reason: 'parse-failed', capturedHeaders: undefined }, target, broker: 'hosted', budget: { remaining: 10 } })).toBeUndefined();
    expect(describeCspObservationForUiMessagesOnly({ observation: original, target, broker: 'hosted', budget: { remaining: 0 } })).toBeUndefined();
  });

  it('does not explain unsupported provider URL schemes as remote connection failures', () => {
    expect(hint({ serialized: "connect-src 'none'", target: { kind: 'connection', endpoint: 'data:text/plain,local', apiPath: '/models' }, broker: 'hosted' })).toBeUndefined();
  });

  it('treats insecure request upgrading as a setting of the full enforce policy set', () => {
    const target: CspHintTarget = { kind: 'connection', endpoint: 'http://api.example', apiPath: '/models' };
    expect(hint({ serialized: 'upgrade-insecure-requests, connect-src https://api.example', target, broker: 'hosted' })).toBeUndefined();
    expect(hint({ serialized: 'connect-src https://api.example, upgrade-insecure-requests', target, broker: 'hosted' })).toBeUndefined();
    const enforced = observation({ serialized: 'connect-src https://api.example' });
    const report = parseCsp({ serialized: 'upgrade-insecure-requests' });
    if (report.kind !== 'parsed') {
      throw new Error('invalid fixture');
    }
    expect(describeCspObservationForUiMessagesOnly({
      observation: { ...enforced, reportOnly: { serialized: 'upgrade-insecure-requests', parsed: report.value } },
      target,
      broker: 'hosted',
      budget: { remaining: 65_536 },
    })).toBeDefined();
  });

  it('preserves separate policy rows in the Developer connection summary', () => {
    const result = parseCsp({ serialized: "connect-src 'self', connect-src https://api.example" });
    if (result.kind !== 'parsed') {
      throw new Error('invalid fixture');
    }
    const summary = summarizeCspConnectionsForDisplayOnly({ parsed: result.value });
    expect(summary).toHaveLength(2);
    expect(summary?.[0]?.sourceDescriptions).toEqual([{ kind: 'self' }]);
    expect(summary?.[1]?.sourceDescriptions).toEqual([{ kind: 'host', value: 'https://api.example' }]);
  });

  it('applies installed meta evidence only to the main Document, including frame and Worker creation', () => {
    const observed = observation({ serialized: '' });
    const result = parseCsp({ serialized: "connect-src 'none'; frame-ancestors 'none'; script-src 'none'; worker-src 'none'" });
    if (result.kind !== 'parsed') {
      throw new Error('invalid meta fixture');
    }
    const documentMeta = { serialized: result.value.serialized, parsed: result.value };
    const forTarget = ({ target }: { target: CspHintTarget }) => describeCspAndDevelopmentMetaForUiMessagesOnly({ privacyBroker: { lifetime: 'not-created', metas: [] }, observation: observed, documentMetas: [documentMeta], target, broker: 'hosted', budget: { remaining: 65_536 } });
    // Broker connect/script/frame-ancestors remain governed by their response,
    // not a meta inserted into the parent Document.
    expect(forTarget({ target: { kind: 'wikipedia' } })).toBeUndefined();
    expect(forTarget({ target: { kind: 'connection', endpoint: 'https://api.example', apiPath: '/models' } })?.details).toMatchObject([{ directive: 'connect-src', context: 'document' }]);
    expect(forTarget({ target: { kind: 'huggingface-download' } })?.details).toMatchObject([{ directive: 'worker-src', context: 'document' }]);
    expect(forTarget({ target: { kind: 'resource', url: 'https://api.example/x', destination: 'connect', realm: 'same-origin-worker' } })).toBeUndefined();
    const frames = parseCsp({ serialized: "frame-src 'none'" });
    if (frames.kind !== 'parsed') {
      throw new Error('invalid meta fixture');
    }
    expect(describeCspAndDevelopmentMetaForUiMessagesOnly({ privacyBroker: { lifetime: 'not-created', metas: [] }, observation: observed, documentMetas: [{ serialized: frames.value.serialized, parsed: frames.value }], target: { kind: 'wikipedia' }, broker: 'hosted', budget: { remaining: 65_536 } })?.details).toMatchObject([{ directive: 'frame-src', context: 'document' }]);
  });

  it('intersects header and actual meta evidence without letting one replace the other', () => {
    const meta = parseCsp({ serialized: "connect-src https://api.example; img-src 'none'" });
    if (meta.kind !== 'parsed') {
      throw new Error('invalid meta fixture');
    }
    const value = describeCspAndDevelopmentMetaForUiMessagesOnly({ privacyBroker: { lifetime: 'not-created', metas: [] }, observation: observation({ serialized: "connect-src 'none'" }), documentMetas: [{ serialized: meta.value.serialized, parsed: meta.value }], target: { kind: 'connection', endpoint: 'https://api.example', apiPath: '/models' }, broker: 'hosted', budget: { remaining: 65_536 } });
    expect(value?.details).toMatchObject([{ directive: 'connect-src', sources: ["'none'"] }]);
  });

  it('does not misdiagnose HTTP URLs upgraded by either a header or the actual Document meta', () => {
    const target: CspHintTarget = { kind: 'connection', endpoint: 'http://api.example', apiPath: '/models' };
    for (const [header, serialized] of [
      ['connect-src https://api.example', 'upgrade-insecure-requests'],
      ['upgrade-insecure-requests', 'connect-src https://api.example'],
    ] as const) {
      const meta = parseCsp({ serialized });
      if (meta.kind !== 'parsed') {
        throw new Error('invalid meta fixture');
      }
      expect(describeCspAndDevelopmentMetaForUiMessagesOnly({ privacyBroker: { lifetime: 'not-created', metas: [] }, observation: observation({ serialized: header }), documentMetas: [{ serialized, parsed: meta.value }], target, broker: 'hosted', budget: { remaining: 65_536 } })).toBeUndefined();
    }
  });

  it('distinguishes no managed meta from incomplete diagnostics and suppresses partial budget results', () => {
    const target: CspHintTarget = { kind: 'connection', endpoint: 'https://api.example', apiPath: '/models' };
    const observed = observation({ serialized: "connect-src 'none'" });
    expect(describeCspAndDevelopmentMetaForUiMessagesOnly({ privacyBroker: { lifetime: 'not-created', metas: [] }, observation: observed, documentMetas: [], target, broker: 'hosted', budget: { remaining: 65_536 } })).toBeDefined();
    expect(describeCspAndDevelopmentMetaForUiMessagesOnly({ privacyBroker: { lifetime: 'not-created', metas: [] }, observation: observed, documentMetas: undefined, target, broker: 'hosted', budget: { remaining: 65_536 } })).toBeUndefined();
    const meta = parseCsp({ serialized: 'connect-src *' });
    if (meta.kind !== 'parsed') {
      throw new Error('invalid meta fixture');
    }
    expect(describeCspAndDevelopmentMetaForUiMessagesOnly({ privacyBroker: { lifetime: 'not-created', metas: [] }, observation: observed, documentMetas: [{ serialized: meta.value.serialized, parsed: meta.value }], target, broker: 'hosted', budget: { remaining: 1 } })).toBeUndefined();
  });

  it('keeps all managed policies independent and applies upgrading from any actual meta', () => {
    const metas = ["connect-src 'none'", 'connect-src *'].map(serialized => {
      const parsed = parseCsp({ serialized });
      if (parsed.kind !== 'parsed') {
        throw new Error('invalid meta fixture');
      }
      return { serialized, parsed: parsed.value };
    });
    const observed = observation({ serialized: 'connect-src *' });
    expect(describeCspAndDevelopmentMetaForUiMessagesOnly({ privacyBroker: { lifetime: 'not-created', metas: [] }, observation: observed, documentMetas: metas, target: { kind: 'connection', endpoint: 'https://api.example', apiPath: '/models' }, broker: 'hosted', budget: { remaining: 65_536 } })?.details).toMatchObject([{ sources: ["'none'"] }]);
    const upgraded = ['connect-src https://api.example', 'upgrade-insecure-requests'].map(serialized => {
      const parsed = parseCsp({ serialized });
      if (parsed.kind !== 'parsed') {
        throw new Error('invalid meta fixture');
      }
      return { serialized, parsed: parsed.value };
    });
    for (const documentMetas of [upgraded, [...upgraded].reverse()]) {
      expect(describeCspAndDevelopmentMetaForUiMessagesOnly({ privacyBroker: { lifetime: 'not-created', metas: [] }, observation: observed, documentMetas, target: { kind: 'connection', endpoint: 'http://api.example', apiPath: '/models' }, broker: 'hosted', budget: { remaining: 65_536 } })).toBeUndefined();
    }
  });

  it.each(['huggingface-metadata', 'huggingface-download', 'wikipedia'] as const)('explains local-only exclusions after the localhost broker confirms every policy: %s', kind => {
    const parsed = parseCsp({ serialized: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self' http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'" });
    if (parsed.kind !== 'parsed') {
      throw new Error('invalid fixture');
    }
    const meta = { serialized: parsed.value.serialized, parsed: parsed.value };
    const observed = { ...observation({ serialized: '' }), documentUrl: 'http://localhost:5173/' };
    const result = describeCspAndDevelopmentMetaForUiMessagesOnly({ observation: observed, documentMetas: [meta], privacyBroker: { lifetime: 'ready', metas: [meta] }, target: { kind }, broker: 'hosted', budget: { remaining: 65_536 } });
    expect(result?.details).toMatchObject([{ directive: 'connect-src', context: 'privacy-broker' }]);
    expect(result?.details).toHaveLength(1);
  });

  it('does not turn ambiguous same-host self upgrades or a Wikipedia language family into exclusions', () => {
    const parsed = parseCsp({ serialized: "connect-src 'self'" });
    if (parsed.kind !== 'parsed') {
      throw new Error('invalid fixture');
    }
    const meta = { serialized: parsed.value.serialized, parsed: parsed.value };
    const cases: { documentUrl: string, target: CspHintTarget }[] = [
      { documentUrl: 'http://huggingface.co/', target: { kind: 'huggingface-metadata' } },
      { documentUrl: 'http://en.wikipedia.org/', target: { kind: 'wikipedia' } },
      { documentUrl: 'http://wikipedia.org/', target: { kind: 'wikipedia' } },
      { documentUrl: 'ftp://localhost/', target: { kind: 'huggingface-metadata' } },
    ];
    for (const { documentUrl, target } of cases) {
      expect(describeCspAndDevelopmentMetaForUiMessagesOnly({ observation: { ...observation({ serialized: '' }), documentUrl }, documentMetas: [], privacyBroker: { lifetime: 'ready', metas: [meta] }, target, broker: 'hosted', budget: { remaining: 65_536 } })).toBeUndefined();
    }
  });

  it('does not reinterpret loaded broker bootstrap, frame-ancestors, or parent frame restrictions as a current fetch failure', () => {
    const parsed = parseCsp({ serialized: "frame-src 'none'; script-src 'none'; frame-ancestors 'none'" });
    if (parsed.kind !== 'parsed') {
      throw new Error('invalid fixture');
    }
    const meta = { serialized: parsed.value.serialized, parsed: parsed.value };
    const target: CspHintTarget = { kind: 'wikipedia' };
    const observed = observation({ serialized: '' });
    expect(describeCspAndDevelopmentMetaForUiMessagesOnly({ observation: observed, documentMetas: [meta], privacyBroker: { lifetime: 'not-created', metas: [] }, target, broker: 'hosted', budget: { remaining: 65_536 } })?.details).toMatchObject([{ directive: 'frame-src', context: 'document' }]);
    expect(describeCspAndDevelopmentMetaForUiMessagesOnly({ observation: observed, documentMetas: [meta], privacyBroker: { lifetime: 'ready', metas: [meta] }, target, broker: 'hosted', budget: { remaining: 65_536 } })).toBeUndefined();
  });

  it('omits uncertain broker fetch hints without losing known main Document evidence', () => {
    const observed = observation({ serialized: "connect-src 'none'" });
    const privacyBroker = { lifetime: 'ready' as const, metas: undefined };
    expect(describeCspAndDevelopmentMetaForUiMessagesOnly({ observation: observed, documentMetas: [], privacyBroker, target: { kind: 'wikipedia' }, broker: 'hosted', budget: { remaining: 65_536 } })).toBeUndefined();
    expect(describeCspAndDevelopmentMetaForUiMessagesOnly({ observation: observed, documentMetas: [], privacyBroker, target: { kind: 'connection', endpoint: 'https://api.example', apiPath: '/models' }, broker: 'hosted', budget: { remaining: 65_536 } })?.details).toMatchObject([{ directive: 'connect-src', context: 'document' }]);
  });

  it('does not merge broker policy permissions or apply broker URL upgrading to the main Document', () => {
    const metas = ["connect-src 'none'", 'connect-src *', 'upgrade-insecure-requests'].map(serialized => {
      const parsed = parseCsp({ serialized });
      if (parsed.kind !== 'parsed') {
        throw new Error('invalid fixture');
      }
      return { serialized, parsed: parsed.value };
    });
    expect(describeCspAndDevelopmentMetaForUiMessagesOnly({ observation: observation({ serialized: '' }), documentMetas: [], privacyBroker: { lifetime: 'ready', metas }, target: { kind: 'wikipedia' }, broker: 'hosted', budget: { remaining: 65_536 } })?.details).toMatchObject([{ sources: ["'none'"], context: 'privacy-broker' }]);
    expect(describeCspAndDevelopmentMetaForUiMessagesOnly({ observation: observation({ serialized: 'connect-src https://api.example' }), documentMetas: [], privacyBroker: { lifetime: 'ready', metas }, target: { kind: 'connection', endpoint: 'http://api.example', apiPath: '/models' }, broker: 'hosted', budget: { remaining: 65_536 } })).toBeDefined();
  });
});
