import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { CspHintMessage, CspHintTarget } from '@/logic/csp-message-hints/types';
import { describeCspHintForDisplayOnly } from './hint-copy';
import type { CspHintActivityForDisplayOnly } from './types';

const message: CspHintMessage = {
  tone: 'caution',
  subject: 'connection',
  suggestedDeployments: [],
  details: [{ directive: 'connect-src', context: 'privacy-broker', sources: ["'none'"], sourceDescriptions: [{ kind: 'none' }] }],
};

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('display activity without request authority', () => {
  it.each([
    { activity: 'connection', expected: 'このURLに接続できない場合があります' },
    { activity: 'model-list', expected: 'モデル一覧を取得できない場合があります' },
    { activity: 'response-generation', expected: '回答を生成できない場合があります' },
    { activity: 'image-generation', expected: '画像を生成できない場合があります' },
    { activity: 'title-generation', expected: 'タイトルを生成できない場合があります' },
    { activity: 'context-summary', expected: '会話を要約できない場合があります' },
    { activity: 'prompt-translation', expected: 'プロンプトを翻訳できない場合があります' },
    { activity: 'model-search', expected: 'モデルを検索できない場合があります' },
    { activity: 'model-information', expected: 'モデル情報を取得できない場合があります' },
    { activity: 'quantization-options', expected: '量子化の候補を取得できない場合があります' },
    { activity: 'download', expected: 'ダウンロードできない場合があります' },
    { activity: 'running-models', expected: '実行中のモデルを確認できない場合があります' },
    { activity: 'unload-model', expected: 'モデルをメモリから解放できない場合があります' },
    { activity: 'wikipedia', expected: 'Wikipediaを利用できない場合があります' },
    { activity: 'relay', expected: '中継サーバーに接続できない場合があります' },
  ] satisfies { activity: CspHintActivityForDisplayOnly, expected: string }[])('describes $activity while preserving the actual request and error guidance', async ({ activity, expected }) => {
    await ensureAllStringsForTest({ locale: 'ja' });
    const target: CspHintTarget = Object.freeze({ kind: 'connection', endpoint: 'https://models.example', apiPath: '/api/generate' });
    const baseline = describeCspHintForDisplayOnly({ presentation: 'compact', message, target, activityForDisplayOnly: undefined });
    const copy = describeCspHintForDisplayOnly({ presentation: 'compact', message, target, activityForDisplayOnly: activity });
    expect(baseline).toBeDefined();
    expect(copy).toEqual({ ...baseline, summary: expected });
    expect(target).toEqual({ kind: 'connection', endpoint: 'https://models.example', apiPath: '/api/generate' });
    expect(message.details).toHaveLength(1);
  });

  it.each([
    { target: { kind: 'huggingface-download' }, expected: 'Downloads may fail' },
    { target: { kind: 'huggingface-metadata' }, expected: 'Model information may not load' },
    { target: { kind: 'wikipedia' }, expected: 'Wikipedia may not be available' },
    { target: { kind: 'relay', url: 'https://relay.example' }, expected: 'The relay server may be unreachable' },
  ] satisfies { target: CspHintTarget, expected: string }[])('uses a known feature target only when no display activity was supplied: $target.kind', ({ target, expected }) => {
    expect(describeCspHintForDisplayOnly({ presentation: 'compact', message, target, activityForDisplayOnly: undefined })?.summary).toBe(expected);
    expect(describeCspHintForDisplayOnly({ presentation: 'compact', message, target, activityForDisplayOnly: 'model-search' })?.summary).toBe('Model search may fail');
  });

  it('retains the generic resource wording without inferring an operation from its URL', () => {
    const target: CspHintTarget = { kind: 'resource', url: 'https://assets.example/models/download', destination: 'image', realm: 'document' };
    expect(describeCspHintForDisplayOnly({ presentation: 'compact', message: { ...message, subject: 'image' }, target, activityForDisplayOnly: undefined })?.summary).toBe('This image may not be displayed');
  });

  it('omits the hint for an unexpected runtime activity instead of displaying a raw identifier', () => {
    const context: { activityForDisplayOnly: CspHintActivityForDisplayOnly } = { activityForDisplayOnly: 'download' };
    Object.defineProperty(context, 'activityForDisplayOnly', { value: 'future-private-activity' });
    expect(describeCspHintForDisplayOnly({ presentation: 'compact', message, target: undefined, ...context })).toBeUndefined();
  });

  it('does not create an activity warning without an observed restriction message', () => {
    expect(describeCspHintForDisplayOnly({ presentation: 'compact', message: undefined, target: { kind: 'huggingface-download' }, activityForDisplayOnly: 'download' })).toBeUndefined();
  });

  it('keeps the error entry independent of a compact activity that is not displayed', () => {
    const copy = describeCspHintForDisplayOnly({ presentation: 'error', message, target: { kind: 'huggingface-download' }, activityForDisplayOnly: 'download' });
    expect(copy?.summary).toBe('Hints for resolving this error');
    expect(copy?.errorSummary).toBe('Hints for resolving this error');
    expect(copy?.rows).toHaveLength(1);
  });
});

describe('destination URL as an optional hint display supplement', () => {
  it('preserves the entire readonly candidate list without reordering or mutating it', () => {
    const suggestedDeployments = Object.freeze([
      Object.freeze({ id: 'standard' } as const),
      Object.freeze({ id: 'curated' } as const),
    ]);
    const copy = describeCspHintForDisplayOnly({ presentation: 'compact', activityForDisplayOnly: undefined, message: Object.freeze({ ...message, subject: 'huggingface', suggestedDeployments }), target: { kind: 'huggingface-download' } });
    expect(copy?.suggestedDeployments).toBe(suggestedDeployments);
    expect(copy?.suggestedDeployments).toEqual([
      { id: 'standard' },
      { id: 'curated' },
    ]);
  });

  it('identifies the configured endpoint while removing userinfo, query, and fragment', () => {
    const endpoint = 'https://private-user:private-password@api.example:8443/v1?api_key=private-query#private-fragment';
    const target: CspHintTarget = Object.freeze({ kind: 'connection', endpoint, apiPath: '/models' });
    const baseline = describeCspHintForDisplayOnly({ presentation: 'compact', activityForDisplayOnly: undefined, message, target: undefined });
    const copy = describeCspHintForDisplayOnly({ presentation: 'compact', activityForDisplayOnly: undefined, message, target });
    expect(baseline).toBeDefined();
    expect(copy).toEqual({ ...baseline, destinationUrl: 'https://api.example:8443/v1', explanation: 'This destination (https://api.example:8443/v1) is outside the allowed range.' });
    expect(JSON.stringify(copy)).not.toContain('private-');
    expect(target.endpoint).toBe(endpoint);
  });

  it.each([
    { value: 'http://user:secret@localhost:11434/api?key=secret#secret', expected: 'http://localhost:11434/api' },
    { value: 'ws://user:secret@relay.example/socket?key=secret#secret', expected: 'ws://relay.example/socket' },
    { value: 'wss://user:secret@relay.example/socket?key=secret#secret', expected: 'wss://relay.example/socket' },
  ])('supports safe network schemes for the configured relay: $expected', ({ value, expected }) => {
    const copy = describeCspHintForDisplayOnly({ presentation: 'compact', activityForDisplayOnly: undefined, message, target: { kind: 'relay', url: value } });
    expect(copy?.destinationUrl).toBe(expected);
    expect(copy?.explanation).toBe(`This destination (${expected}) is outside the allowed range.`);
    expect(JSON.stringify(copy)).not.toContain('secret');
  });

  it('identifies a single resource without changing its URL or request realm', () => {
    const target = Object.freeze({ kind: 'resource', url: 'https://images.example/f.png?signature=secret#secret', destination: 'image', realm: 'same-origin-worker' } as const);
    const copy = describeCspHintForDisplayOnly({ presentation: 'compact', activityForDisplayOnly: undefined, message: { ...message, subject: 'image' }, target });
    expect(copy?.destinationUrl).toBe('https://images.example/f.png');
    expect(copy?.explanation).toBe('This resource source (https://images.example/f.png) is outside the allowed range.');
    expect(target.url).toContain('?signature=secret');
    expect(target.realm).toBe('same-origin-worker');
  });

  it('places the redacted submission destination in its localized explanation', () => {
    const copy = describeCspHintForDisplayOnly({ presentation: 'compact', activityForDisplayOnly: undefined, message: { ...message, subject: 'form' }, target: { kind: 'resource', url: 'https://forms.example/submit?secret=private#private', destination: 'form', realm: 'document' } });
    expect(copy?.explanation).toBe('This submission destination (https://forms.example/submit) is outside the allowed range.');
  });

  it('uses the requested Japanese wording with and without an identifiable URL', async () => {
    await ensureAllStringsForTest({ locale: 'ja' });
    expect(describeCspHintForDisplayOnly({ presentation: 'compact', activityForDisplayOnly: undefined, message, target: { kind: 'connection', endpoint: 'https://user:private@api.example/v1?secret=private#private', apiPath: '/models' } })?.explanation).toBe('この接続先（https://api.example/v1）は、この許可範囲に含まれていません。');
    expect(describeCspHintForDisplayOnly({ presentation: 'compact', activityForDisplayOnly: undefined, message, target: undefined })?.explanation).toBe('この接続先は、この許可範囲に含まれていません。');
  });

  it('formats a safe destination only once for the URL and explanation fields', () => {
    const construct = vi.fn();
    const NativeUrl = URL;
    vi.stubGlobal('URL', class extends NativeUrl {
      constructor() {
        super('https://api.example/v1');
        construct();
      }
    });
    const copy = describeCspHintForDisplayOnly({ presentation: 'compact', activityForDisplayOnly: undefined, message, target: { kind: 'connection', endpoint: 'https://api.example/v1', apiPath: '/models' } });
    expect(construct).toHaveBeenCalledOnce();
    expect(copy?.explanation).toBe('This destination (https://api.example/v1) is outside the allowed range.');
  });

  it('does not invent a representative URL for a feature or resource group', () => {
    const targets: CspHintTarget[] = [
      { kind: 'wikipedia' }, { kind: 'huggingface-metadata' }, { kind: 'huggingface-download' },
      { kind: 'resource-list', resources: [{ url: 'https://images.example/f.png', destination: 'image', realm: 'document' }] },
      { kind: 'connection', endpoint: undefined, apiPath: '/models' }, { kind: 'relay', url: undefined },
    ];
    const baseline = describeCspHintForDisplayOnly({ presentation: 'compact', activityForDisplayOnly: 'connection', message, target: undefined });
    expect(baseline).toBeDefined();
    for (const target of targets) {
      expect(describeCspHintForDisplayOnly({ presentation: 'compact', activityForDisplayOnly: 'connection', message, target })).toEqual(baseline);
    }
  });

  it.each(['/local/proxy', '//api.example/proxy', 'data:text/plain,secret', 'blob:https://app.example/secret', 'javascript:secret', 'file:///secret', 'ftp://user:secret@files.example', 'https://'])('omits unsupported, relative, or invalid input while preserving the hint: %s', endpoint => {
    const baseline = describeCspHintForDisplayOnly({ presentation: 'compact', activityForDisplayOnly: undefined, message, target: undefined });
    expect(baseline).toBeDefined();
    expect(describeCspHintForDisplayOnly({ presentation: 'compact', activityForDisplayOnly: undefined, message, target: { kind: 'connection', endpoint, apiPath: '/models' } })).toEqual(baseline);
  });

  it('checks oversized input before constructing or formatting any URL', () => {
    const construct = vi.fn();
    vi.stubGlobal('URL', class {
      constructor() {
        construct();
        throw new Error('URL parsing must not run for oversized input.');
      }
    });
    const baseline = describeCspHintForDisplayOnly({ presentation: 'compact', activityForDisplayOnly: undefined, message, target: undefined });
    expect(describeCspHintForDisplayOnly({ presentation: 'compact', activityForDisplayOnly: undefined, message, target: { kind: 'connection', endpoint: `https://api.example/${'a'.repeat(4_096)}`, apiPath: '/models' } })).toEqual(baseline);
    expect(construct).not.toHaveBeenCalled();
  });

  it('omits a long display path while retaining the existing hint', () => {
    const baseline = describeCspHintForDisplayOnly({ presentation: 'compact', activityForDisplayOnly: undefined, message, target: undefined });
    expect(describeCspHintForDisplayOnly({ presentation: 'compact', activityForDisplayOnly: undefined, message, target: { kind: 'connection', endpoint: `https://api.example/${'a'.repeat(512)}`, apiPath: '/models' } })).toEqual(baseline);
  });

  it('contains URL construction failure without losing policy details', () => {
    const baseline = describeCspHintForDisplayOnly({ presentation: 'compact', activityForDisplayOnly: undefined, message, target: undefined });
    vi.stubGlobal('URL', class {
      constructor() {
        throw new Error('optional URL constructor failure');
      }
    });
    expect(describeCspHintForDisplayOnly({ presentation: 'compact', activityForDisplayOnly: undefined, message, target: { kind: 'connection', endpoint: 'https://api.example', apiPath: '/models' } })).toEqual(baseline);
  });

  it('contains URL serialization failure without losing policy details', () => {
    const baseline = describeCspHintForDisplayOnly({ presentation: 'compact', activityForDisplayOnly: undefined, message, target: undefined });
    const NativeUrl = URL;
    vi.stubGlobal('URL', class extends NativeUrl {
      constructor() {
        super('https://api.example');
        Object.defineProperty(this, 'href', {
          get() {
            throw new Error('optional URL serialization failure');
          },
        });
      }
    });
    expect(describeCspHintForDisplayOnly({ presentation: 'compact', activityForDisplayOnly: undefined, message, target: { kind: 'connection', endpoint: 'https://api.example', apiPath: '/models' } })).toEqual(baseline);
  });
});
