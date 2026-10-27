import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CspHintTarget, CspObservationSnapshot, CspSuggestedDeployment } from './types';

const coveredStandard: CspSuggestedDeployment = Object.freeze({ id: 'standard' });
const coveredCurated: CspSuggestedDeployment = Object.freeze({ id: 'curated' });
const referenceBootstrap = "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src https://naidan-curated.pages.dev; frame-src 'self'; frame-ancestors 'self'";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function fixture({ target, documentUrl }: { target: CspHintTarget, documentUrl: string }) {
  const parser = await import('@/utils/csp');
  const messages = await import('./messages');
  const serialized = "default-src 'none'; connect-src 'none'; frame-ancestors 'none';";
  const result = parser.parseCsp({ serialized });
  if (result.kind !== 'parsed') {
    throw new Error('The observed policy fixture must parse.');
  }
  const observation: Extract<CspObservationSnapshot, { kind: 'observed' }> = { kind: 'observed', documentUrl, enforce: { serialized, parsed: result.value }, reportOnly: undefined };
  const message = messages.describeCspObservationForUiMessagesOnly({ observation, target, broker: 'hosted', budget: { remaining: 65_536 } });
  if (message === undefined) {
    throw new Error('The fixture must first produce an independent current-policy hint.');
  }
  return { parser, messages, observation, message };
}

describe('display-only deployment references', () => {
  it.each(['wikipedia', 'huggingface-metadata'] as const)('includes both references for %s when all broker and application stages are covered', async kind => {
    const target: CspHintTarget = { kind };
    const { messages, observation, message } = await fixture({ target, documentUrl: 'https://private.example/app/' });
    const result = messages.appendReferenceDeploymentSuggestionsForUiOnly({ message, observation, target, budget: { remaining: 16_384 } });
    expect(result.suggestedDeployments).toEqual([coveredStandard, coveredCurated]);
    expect(result.details).toBe(message.details);
  });

  it('does not recommend Curated for an arbitrary external LM API', async () => {
    const target: CspHintTarget = Object.freeze({ kind: 'connection', endpoint: 'https://api.openai.com/v1?token=private-placeholder#fragment', apiPath: '/models' });
    const { messages, observation, message } = await fixture({ target, documentUrl: 'https://private.example/app/' });
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const result = messages.appendReferenceDeploymentSuggestionsForUiOnly({ message, observation, target, budget: { remaining: 16_384 } });
    expect(result.suggestedDeployments).toEqual([coveredStandard]);
    expect(JSON.stringify(result)).not.toContain('private-placeholder');
    expect(fetcher).not.toHaveBeenCalled();
    expect(target.endpoint).toBe('https://api.openai.com/v1?token=private-placeholder#fragment');
  });

  it('includes standard and Curated for the Hub plus the complete HF subdomain family', async () => {
    const target: CspHintTarget = { kind: 'huggingface-download' };
    const { messages, observation, message } = await fixture({ target, documentUrl: 'https://private.example/' });
    expect(messages.appendReferenceDeploymentSuggestionsForUiOnly({ message, observation, target, budget: { remaining: 16_384 } }).suggestedDeployments).toEqual([coveredStandard, coveredCurated]);
  });

  it.each(['/proxy', '//api.example/proxy', 'https://private.example/proxy'])('omits relocation advice for a relative or same-origin endpoint: %s', async endpoint => {
    const target: CspHintTarget = { kind: 'connection', endpoint, apiPath: '/models' };
    const { messages, observation, message } = await fixture({ target, documentUrl: 'https://private.example/app/' });
    expect(messages.appendReferenceDeploymentSuggestionsForUiOnly({ message, observation, target, budget: { remaining: 16_384 } })).toBe(message);
    expect(message.suggestedDeployments).toEqual([]);
  });

  it('omits advice for a same-origin relay, local object URL, or mixed portable/nonportable resource list', async () => {
    const targets: CspHintTarget[] = [
      { kind: 'relay', url: 'https://private.example/relay' },
      { kind: 'resource', url: 'blob:https://private.example/local-object', destination: 'image', realm: 'document' },
      { kind: 'resource-list', resources: [{ url: 'https://images.example/remote.png', destination: 'image', realm: 'document' }, { url: '/local.png', destination: 'image', realm: 'document' }] },
    ];
    for (const target of targets) {
      const { messages, observation, message } = await fixture({ target, documentUrl: 'https://private.example/app/' });
      expect(messages.appendReferenceDeploymentSuggestionsForUiOnly({ message, observation, target, budget: { remaining: 16_384 } })).toBe(message);
    }
  });

  it.each([
    { documentUrl: 'https://naidan.pages.dev/', expected: [coveredCurated] },
    { documentUrl: 'https://naidan-curated.pages.dev/', expected: [coveredStandard] },
    { documentUrl: 'https://naidan.pages.dev:443/', expected: [coveredCurated] },
    { documentUrl: 'https://naidan-curated.pages.dev:8443/', expected: [coveredStandard, coveredCurated] },
  ])('does not link to the deployment already being displayed: $documentUrl', async ({ documentUrl, expected }) => {
    const target: CspHintTarget = { kind: 'wikipedia' };
    const { messages, observation, message } = await fixture({ target, documentUrl });
    expect(messages.appendReferenceDeploymentSuggestionsForUiOnly({ message, observation, target, budget: { remaining: 16_384 } }).suggestedDeployments).toEqual(expected);
  });

  it('parses the committed Curated reference once without reading remote headers', async () => {
    const target: CspHintTarget = { kind: 'wikipedia' };
    const { parser, messages, observation, message } = await fixture({ target, documentUrl: 'https://private.example/' });
    const parse = vi.spyOn(parser, 'parseCsp');
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const workflow = readFileSync(path.resolve(process.cwd(), '.github/workflows/main.yml'), 'utf8');
    const curated = workflow.split('Create _headers for curated access')[1]?.match(/Content-Security-Policy: ([^\r\n]+)/)?.[1]?.trim();
    const standard = workflow.match(/- name: Create _headers\r?\n([\s\S]*?)- name: Install Wrangler/)?.[1];
    expect(curated).toBeDefined();
    expect(standard).toBeDefined();
    expect(standard).not.toContain('Content-Security-Policy:');
    messages.appendReferenceDeploymentSuggestionsForUiOnly({ message, observation, target, budget: { remaining: 16_384 } });
    messages.appendReferenceDeploymentSuggestionsForUiOnly({ message, observation, target, budget: { remaining: 16_384 } });
    expect(parse).toHaveBeenCalledOnce();
    expect(parse).toHaveBeenCalledWith({ serialized: curated });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps the original hint and known no-CSP candidate when another reference parse fails', async () => {
    const target: CspHintTarget = { kind: 'wikipedia' };
    const { parser, messages, observation, message } = await fixture({ target, documentUrl: 'https://private.example/' });
    const parse = vi.spyOn(parser, 'parseCsp').mockReturnValue({ kind: 'failed', reason: 'too-many-tokens' });
    const first = messages.appendReferenceDeploymentSuggestionsForUiOnly({ message, observation, target, budget: { remaining: 16_384 } });
    expect(first.suggestedDeployments).toEqual([coveredStandard]);
    expect(first.details).toBe(message.details);
    expect(messages.appendReferenceDeploymentSuggestionsForUiOnly({ message, observation, target, budget: { remaining: 16_384 } }).suggestedDeployments).toEqual([coveredStandard]);
    expect(parse).toHaveBeenCalledOnce();
  });

  it('keeps the original hint when optional reference parsing throws or comparison budgets run out', async () => {
    const target: CspHintTarget = { kind: 'wikipedia' };
    const { parser, messages, observation, message } = await fixture({ target, documentUrl: 'https://private.example/' });
    expect(messages.appendReferenceDeploymentSuggestionsForUiOnly({ message, observation, target, budget: { remaining: 0 } })).toBe(message);
    vi.spyOn(parser, 'parseCsp').mockImplementation(() => {
      throw new Error('optional reference parse failure');
    });
    const result = messages.appendReferenceDeploymentSuggestionsForUiOnly({ message, observation, target, budget: { remaining: 16_384 } });
    expect(result.suggestedDeployments).toEqual([coveredStandard]);
    expect(result.details).toBe(message.details);
  });

  it('retains the no-CSP candidate when another candidate has no comparison allowance', async () => {
    const target: CspHintTarget = { kind: 'wikipedia' };
    const { messages, observation, message } = await fixture({ target, documentUrl: 'https://private.example/' });
    const result = messages.appendReferenceDeploymentSuggestionsForUiOnly({ message, observation, target, budget: { remaining: 1 } });
    expect(result.suggestedDeployments).toEqual([coveredStandard]);
    expect(result.details).toBe(message.details);
    expect(message.suggestedDeployments).toEqual([]);
  });

  it('omits a reference with unknown future policy syntax without turning it into permission', async () => {
    const target: CspHintTarget = { kind: 'wikipedia' };
    const { parser, messages, observation, message } = await fixture({ target, documentUrl: 'https://private.example/' });
    const future = parser.parseCsp({ serialized: "connect-src 'future-origin-source'" });
    vi.spyOn(parser, 'parseCsp').mockReturnValue(future);
    expect(messages.appendReferenceDeploymentSuggestionsForUiOnly({ message, observation, target, budget: { remaining: 16_384 } }).suggestedDeployments).toEqual([coveredStandard]);
  });

  it.each([
    "frame-src 'none'",
    "script-src 'self'",
  ])('requires broker preparation evidence as well as external connect permission: %s', async preparation => {
    const target: CspHintTarget = { kind: 'wikipedia' };
    const { parser, messages, observation, message } = await fixture({ target, documentUrl: 'https://private.example/' });
    const reference = parser.parseCsp({ serialized: `default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src *; frame-ancestors 'self'; ${preparation}` });
    vi.spyOn(parser, 'parseCsp').mockReturnValue(reference);
    expect(messages.appendReferenceDeploymentSuggestionsForUiOnly({ message, observation, target, budget: { remaining: 16_384 } }).suggestedDeployments).toEqual([coveredStandard]);
  });

  it('requires the download Worker even if every external host and broker stage is permitted', async () => {
    const target: CspHintTarget = { kind: 'huggingface-download' };
    const { parser, messages, observation, message } = await fixture({ target, documentUrl: 'https://private.example/' });
    const reference = parser.parseCsp({ serialized: "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src https://naidan-curated.pages.dev; connect-src *; frame-src 'self'; frame-ancestors 'self'; worker-src 'none'" });
    vi.spyOn(parser, 'parseCsp').mockReturnValue(reference);
    expect(messages.appendReferenceDeploymentSuggestionsForUiOnly({ message, observation, target, budget: { remaining: 16_384 } }).suggestedDeployments).toEqual([coveredStandard]);
  });

  it.each([
    "style-src 'none'",
    "font-src 'none'",
    "connect-src 'none'",
  ])('does not merge a restrictive second policy into a more permissive reference: %s', async restriction => {
    const target: CspHintTarget = { kind: 'wikipedia' };
    const { parser, messages, observation, message } = await fixture({ target, documentUrl: 'https://private.example/' });
    const reference = parser.parseCsp({ serialized: `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src https://naidan-curated.pages.dev; connect-src *; frame-src 'self'; frame-ancestors 'self', ${restriction}` });
    vi.spyOn(parser, 'parseCsp').mockReturnValue(reference);
    expect(messages.appendReferenceDeploymentSuggestionsForUiOnly({ message, observation, target, budget: { remaining: 16_384 } }).suggestedDeployments).toEqual([coveredStandard]);
  });

  it.each(['https://*.wikipedia.org:8443', 'https://*.wikipedia.org/other/'])('does not treat a language wildcard as permission to ignore ports or paths: %s', async source => {
    const target: CspHintTarget = { kind: 'wikipedia' };
    const { parser, messages, observation, message } = await fixture({ target, documentUrl: 'https://private.example/' });
    const reference = parser.parseCsp({ serialized: `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src https://naidan-curated.pages.dev; connect-src ${source}; frame-src 'self'; frame-ancestors 'self'` });
    vi.spyOn(parser, 'parseCsp').mockReturnValue(reference);
    expect(messages.appendReferenceDeploymentSuggestionsForUiOnly({ message, observation, target, budget: { remaining: 16_384 } }).suggestedDeployments).toEqual([coveredStandard]);
  });

  it.each([
    { sources: 'https://huggingface.co https://*.hf.co', expected: [coveredStandard, coveredCurated] },
    { sources: 'https://huggingface.co http://*.hf.co', expected: [coveredStandard, coveredCurated] },
    { sources: 'https://huggingface.co https://*.hf.co:443', expected: [coveredStandard, coveredCurated] },
    { sources: 'https://huggingface.co https://*.co', expected: [coveredStandard, coveredCurated] },
    { sources: 'https:', expected: [coveredStandard, coveredCurated] },
    { sources: '*', expected: [coveredStandard, coveredCurated] },
    { sources: 'https://huggingface.co https://one.hf.co', expected: [coveredStandard] },
    { sources: 'https://huggingface.co https://*.narrow.hf.co', expected: [coveredStandard] },
    { sources: 'https://huggingface.co https://hf.co', expected: [coveredStandard] },
    { sources: 'https://huggingface.co https://*.hf.co:8443', expected: [coveredStandard] },
    { sources: 'https://huggingface.co https://*.hf.co/specific/', expected: [coveredStandard] },
    { sources: 'https://huggingface.co https://*.hf.co.example', expected: [coveredStandard] },
  ])('requires source coverage of the complete HTTPS delivery family: $sources', async ({ sources, expected }) => {
    const target: CspHintTarget = { kind: 'huggingface-download' };
    const { parser, messages, observation, message } = await fixture({ target, documentUrl: 'http://localhost:5173/' });
    const reference = parser.parseCsp({ serialized: `${referenceBootstrap}; connect-src ${sources}` });
    vi.spyOn(parser, 'parseCsp').mockReturnValue(reference);
    const result = messages.appendReferenceDeploymentSuggestionsForUiOnly({ message, observation, target, budget: { remaining: 16_384 } });
    expect(result.suggestedDeployments).toEqual(expected);
    expect(result.details).toBe(message.details);
    expect(message.suggestedDeployments).toEqual([]);
  });

  it.each([
    'https://*.hf.co',
    'https://huggingface.co',
    'https://huggingface.co/api/models https://*.hf.co',
  ])('omits download advice when the Hub or complete delivery family is denied or unknown: %s', async sources => {
    const target: CspHintTarget = { kind: 'huggingface-download' };
    const { parser, messages, observation, message } = await fixture({ target, documentUrl: 'http://localhost:5173/' });
    const reference = parser.parseCsp({ serialized: `${referenceBootstrap}; connect-src ${sources}` });
    vi.spyOn(parser, 'parseCsp').mockReturnValue(reference);
    expect(messages.appendReferenceDeploymentSuggestionsForUiOnly({ message, observation, target, budget: { remaining: 16_384 } }).suggestedDeployments).toEqual([coveredStandard]);
  });

  it.each([
    { firstSource: 'https://one.hf.co', secondSource: 'https://two.hf.co' },
    { firstSource: 'https://*.hf.co', secondSource: 'https://*.narrow.hf.co' },
    { firstSource: 'https://*.hf.co', secondSource: 'https://unrelated.example' },
  ])('requires the entire family in every separate policy: $firstSource / $secondSource', async ({ firstSource, secondSource }) => {
    const target: CspHintTarget = { kind: 'huggingface-download' };
    const { parser, messages, observation, message } = await fixture({ target, documentUrl: 'http://localhost:5173/' });
    const first = `${referenceBootstrap}; connect-src https://huggingface.co ${firstSource}`;
    const second = `${referenceBootstrap}; connect-src https://huggingface.co ${secondSource}`;
    const reference = parser.parseCsp({ serialized: `${first}, ${second}` });
    vi.spyOn(parser, 'parseCsp').mockReturnValue(reference);
    expect(messages.appendReferenceDeploymentSuggestionsForUiOnly({ message, observation, target, budget: { remaining: 16_384 } }).suggestedDeployments).toEqual([coveredStandard]);
  });

  it.each([
    { url: 'https://blocked.example/known-model.gguf', destination: 'connect' as const },
    { url: 'https://huggingface.co/image.png', destination: 'image' as const },
  ])('uses the known resource URL and its own destination rather than a generic profile: $url', async ({ url, destination }) => {
    const target: CspHintTarget = { kind: 'resource', url, destination, realm: 'document' };
    const { messages, observation, message } = await fixture({ target, documentUrl: 'http://localhost:5173/' });
    expect(messages.appendReferenceDeploymentSuggestionsForUiOnly({ message, observation, target, budget: { remaining: 16_384 } }).suggestedDeployments).toEqual([coveredStandard]);
  });

  it('isolates an exhausted candidate budget without rolling back the no-CSP candidate', async () => {
    const target: CspHintTarget = { kind: 'resource-list', resources: Array.from({ length: 16 }, (_, index) => ({ url: `https://api.example/item-${index}`, destination: 'connect' as const, realm: 'document' as const })) };
    const { parser, messages, observation, message } = await fixture({ target, documentUrl: 'https://private.example/' });
    const manySources = Array.from({ length: 900 }, (_, index) => `https://unused-${index}.example`).join(' ');
    const reference = parser.parseCsp({ serialized: `${referenceBootstrap}; connect-src ${manySources} *` });
    expect(reference.kind).toBe('parsed');
    vi.spyOn(parser, 'parseCsp').mockReturnValue(reference);
    const budget = { remaining: 16_384 };
    const result = messages.appendReferenceDeploymentSuggestionsForUiOnly({ message, observation, target, budget });
    expect(result.suggestedDeployments).toEqual([coveredStandard]);
    expect(result.details).toBe(message.details);
    expect(budget.remaining).toBeGreaterThanOrEqual(0);
    expect(budget.remaining).toBeLessThan(16_384);
  });

  it('does not generate candidate-only UI when the current observation failed', async () => {
    const target: CspHintTarget = { kind: 'huggingface-download' };
    const { messages, message } = await fixture({ target, documentUrl: 'http://localhost:5173/' });
    expect(messages.appendReferenceDeploymentSuggestionsForUiOnly({ message, observation: { kind: 'unavailable', reason: 'parse-failed', capturedHeaders: undefined }, target, budget: { remaining: 16_384 } })).toBe(message);
  });

  it('treats permission for a future individual subdomain as partial knowledge of the family', async () => {
    const target: CspHintTarget = { kind: 'huggingface-download' };
    const { parser, messages, observation, message } = await fixture({ target, documentUrl: 'http://localhost:5173/' });
    const serialized = 'connect-src https://huggingface.co https://future-delivery.hf.co';
    const current = parser.parseCsp({ serialized });
    const reference = parser.parseCsp({ serialized: `${referenceBootstrap}; ${serialized}` });
    if (current.kind !== 'parsed' || reference.kind !== 'parsed') {
      throw new Error('invalid fixture');
    }
    const partialObservation = { ...observation, enforce: { serialized, parsed: current.value } };
    expect(messages.describeCspObservationForUiMessagesOnly({ observation: partialObservation, target, broker: 'hosted', budget: { remaining: 65_536 } })).toBeUndefined();
    vi.spyOn(parser, 'parseCsp').mockReturnValue(reference);
    expect(messages.appendReferenceDeploymentSuggestionsForUiOnly({ message, observation, target, budget: { remaining: 16_384 } }).suggestedDeployments).toEqual([coveredStandard]);
  });
});
