import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { shallowRef, type ShallowRef } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { parseCsp } from '@/utils/csp';
import type { CspDeveloperSnapshot, CspObservationSnapshot } from '@/logic/csp-message-hints/types';
import type { DevelopmentMetaCspSnapshotNotForSecurity } from '@/logic/development-meta-csp/types';
import DeveloperCspDiagnosticsContent from './DeveloperCspDiagnosticsContent.vue';
import * as allowedHtml from '@/logic/security/allowedHtml';

const useDeveloper = vi.hoisted(() => vi.fn());
const useDevelopmentMeta = vi.hoisted(() => vi.fn());
vi.mock('@/composables/useCspMessageHintsOnly', () => ({ useCachedCspParseResultForDeveloperDisplayOnly: useDeveloper }));
vi.mock('@/composables/useDevelopmentMetaCspNotForSecurity', () => ({ useDevelopmentMetaCspNotForSecurity: useDevelopmentMeta }));

let snapshot: ShallowRef<CspDeveloperSnapshot>;
let api: {
  snapshot: ShallowRef<CspDeveloperSnapshot>,
};
let storageCurrent: boolean;
let metaApi: {
  snapshot: ShallowRef<DevelopmentMetaCspSnapshotNotForSecurity>,
  savedSerialized: ShallowRef<string | undefined>,
  operation: ShallowRef<'idle' | 'saving' | 'failed' | 'changed' | 'saved'>,
  captureStorageForDevelopmentMetaCspNotForSecurity: ReturnType<typeof vi.fn>,
  prepareResidentRecoveryAndApplySavedMetaForDevelopmentNotForSecurity: ReturnType<typeof vi.fn>,
  saveDevelopmentMetaCspNotForSecurity: ReturnType<typeof vi.fn<({ serialized, isCurrent }: { serialized: string | undefined, isCurrent(): boolean }) => Promise<'saved' | 'changed' | 'failed' | 'busy'>>>,
  clearDevelopmentMetaCspNotForSecurity: ReturnType<typeof vi.fn>,
};
const initialBroker: DevelopmentMetaCspSnapshotNotForSecurity['privacyBroker'] = {
  kind: 'not-created',
  sessionId: undefined,
  syncId: undefined,
  requestedPolicyCount: 0,
  confirmedPolicyCount: 0,
  reason: undefined,
};

function observation({ serialized }: { serialized: string }): CspObservationSnapshot {
  if (serialized === '') {
    return { kind: 'observed', documentUrl: 'https://app.invalid/', enforce: undefined, reportOnly: undefined };
  }
  const parsed = parseCsp({ serialized });
  if (parsed.kind === 'failed') {
    return { kind: 'unavailable', reason: 'parse-failed', capturedHeaders: undefined };
  }
  return { kind: 'observed', documentUrl: 'https://app.invalid/', enforce: { serialized, parsed: parsed.value }, reportOnly: undefined };
}

function publishAddition({ serialized }: { serialized: string }): void {
  const parsed = parseCsp({ serialized });
  if (parsed.kind !== 'parsed') {
    throw new Error('Added meta fixture must parse');
  }
  const addition = { serialized, policies: [serialized], source: 'developer-action' as const };
  metaApi.snapshot.value = { ...metaApi.snapshot.value, preparation: 'ready', installation: { ...addition, kind: 'added' }, additions: [...metaApi.snapshot.value.additions, addition] };
  snapshot.value = { ...snapshot.value, addedMetaParsed: [...(snapshot.value.addedMetaParsed ?? []), parsed.value] };
}

async function openParsed({ wrapper }: { wrapper: VueWrapper }): Promise<void> {
  const details = wrapper.get<HTMLDetailsElement>('[data-testid="developer-csp-json-details"]');
  details.element.open = true;
  await details.trigger('toggle');
}

describe('Developer CSP diagnostics', () => {
  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    snapshot = shallowRef<CspDeveloperSnapshot>({
      observation: observation({ serialized: "connect-src 'self';" }),
      addedMetaParsed: [],
      connectionSummary: [{ directive: 'connect-src', sources: ["'self'"], sourceDescriptions: [{ kind: 'self' }], context: 'document' }],
    });
    api = { snapshot };
    useDeveloper.mockReturnValue(api);
    storageCurrent = true;
    metaApi = {
      snapshot: shallowRef<DevelopmentMetaCspSnapshotNotForSecurity>({ preparation: 'idle', reason: undefined, installation: { kind: 'not-added' }, additions: [], diagnostics: 'complete', privacyBroker: initialBroker }),
      savedSerialized: shallowRef<string>(),
      operation: shallowRef<'idle' | 'saving' | 'failed' | 'changed' | 'saved'>('idle'),
      captureStorageForDevelopmentMetaCspNotForSecurity: vi.fn(() => () => storageCurrent),
      prepareResidentRecoveryAndApplySavedMetaForDevelopmentNotForSecurity: vi.fn(async () => undefined),
      saveDevelopmentMetaCspNotForSecurity: vi.fn(async ({ serialized, isCurrent }) => {
        if (!isCurrent()) {
          metaApi.operation.value = 'changed';
          return 'changed' as const;
        }
        metaApi.savedSerialized.value = serialized;
        return 'saved' as const;
      }),
      clearDevelopmentMetaCspNotForSecurity: vi.fn(async () => {
        metaApi.savedSerialized.value = undefined;
        return 'saved' as const;
      }),
    };
    useDevelopmentMeta.mockReturnValue(metaApi);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not serialize, highlight, or create JSON DOM until explicitly expanded', async () => {
    const stringify = vi.spyOn(JSON, 'stringify');
    const highlight = vi.spyOn(allowedHtml, 'jsonToHighlightedHtml');
    using mounted = {
      wrapper: mount(DeveloperCspDiagnosticsContent),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    const serializedSnapshots = () => stringify.mock.calls.filter(([value]) => typeof value === 'object' && value !== null && 'observed' in value).length;
    expect(serializedSnapshots()).toBe(0);
    expect(highlight).not.toHaveBeenCalled();
    expect(mounted.wrapper.find('[data-testid="developer-csp-parsed-json"]').exists()).toBe(false);
    await openParsed({ wrapper: mounted.wrapper });
    expect(serializedSnapshots()).toBe(1);
    expect(highlight).toHaveBeenCalledOnce();
    expect(mounted.wrapper.find('[data-testid="developer-csp-parsed-json"]').exists()).toBe(true);
    const details = mounted.wrapper.get<HTMLDetailsElement>('[data-testid="developer-csp-json-details"]');
    details.element.open = false;
    await details.trigger('toggle');
    expect(mounted.wrapper.find('[data-testid="developer-csp-parsed-json"]').exists()).toBe(false);
  });

  it('bounds the whole connection overview across sixteen valid policies with five hundred hosts each', () => {
    const sources = Array.from({ length: 500 }, (_, index) => `a${index}`);
    const serialized = Array.from({ length: 16 }, () => `connect-src ${sources.join(' ')};`).join(', ');
    const observed = observation({ serialized });
    expect(observed.kind).toBe('observed');
    snapshot.value = {
      ...snapshot.value,
      observation: observed,
      connectionSummary: Array.from({ length: 16 }, () => ({
        directive: 'connect-src',
        context: 'document' as const,
        sources,
        sourceDescriptions: sources.map(value => ({ kind: 'host' as const, value })),
      })),
    };
    using mounted = {
      wrapper: mount(DeveloperCspDiagnosticsContent),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    const overview = mounted.wrapper.get('[data-testid="developer-csp-connection-summary"]');
    expect(overview.findAll('li')).toHaveLength(0);
    expect(overview.text()).toContain('A connection summary is unavailable');
    expect(mounted.wrapper.get('[data-testid="developer-csp-observed-enforce"]').text()).toBe(serialized);
    expect(mounted.wrapper.find('[data-testid="developer-csp-parsed-json"]').exists()).toBe(false);
    expect(snapshot.value.observation).toBe(observed);
  });

  it('renders the cached JSON through the existing highlighter without interpreting it as HTML', async () => {
    snapshot.value = { ...snapshot.value, observation: observation({ serialized: "connect-src 'self'; report-to <script>test</script>;" }) };
    using mounted = {
      wrapper: mount(DeveloperCspDiagnosticsContent),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await openParsed({ wrapper: mounted.wrapper });
    const json = mounted.wrapper.get('[data-testid="developer-csp-parsed-json"]');
    expect(json.find('span').exists()).toBe(true);
    expect(json.find('script').exists()).toBe(false);
    expect(JSON.parse(json.text()).observed).toEqual(JSON.parse(JSON.stringify(snapshot.value.observation)));
    expect(JSON.parse(json.text()).managedMeta.records).toEqual([]);
    await mounted.wrapper.get('details').trigger('toggle');
    expect(metaApi.saveDevelopmentMetaCspNotForSecurity).not.toHaveBeenCalled();
  });

  it('can serialize an explicit copy request without highlighting or mounting JSON DOM', async () => {
    const highlight = vi.spyOn(allowedHtml, 'jsonToHighlightedHtml');
    const writeText = vi.fn(async (_value: string): Promise<void> => undefined);
    const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    using clipboard = {
      [Symbol.dispose]() {
        if (previous === undefined) {
          Reflect.deleteProperty(navigator, 'clipboard');
        } else {
          Object.defineProperty(navigator, 'clipboard', previous);
        }
      },
    };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    using mounted = {
      wrapper: mount(DeveloperCspDiagnosticsContent),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await mounted.wrapper.get('[data-testid="developer-csp-copy-json"]').trigger('click');
    expect(writeText).toHaveBeenCalledOnce();
    expect(JSON.parse(writeText.mock.calls[0]?.[0] ?? '{}').observed).toEqual(JSON.parse(JSON.stringify(snapshot.value.observation)));
    expect(highlight).not.toHaveBeenCalled();
    expect(mounted.wrapper.find('[data-testid="developer-csp-parsed-json"]').exists()).toBe(false);
    void clipboard;
  });

  it('keeps presets and edits as configuration inputs until an explicit save adds real meta', async () => {
    using mounted = {
      wrapper: mount(DeveloperCspDiagnosticsContent),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    expect(mounted.wrapper.find('[data-testid="developer-csp-apply-ui"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[data-testid="developer-csp-use-observed"]').exists()).toBe(false);
    expect(mounted.wrapper.text()).toContain('must never be used for security');
    await mounted.wrapper.get('[data-testid="developer-csp-preset-local-only"]').trigger('click');
    expect(metaApi.saveDevelopmentMetaCspNotForSecurity).not.toHaveBeenCalled();
    expect(metaApi.prepareResidentRecoveryAndApplySavedMetaForDevelopmentNotForSecurity).not.toHaveBeenCalled();
    expect(mounted.wrapper.findAll('[data-testid="developer-csp-installed-value"]')).toHaveLength(0);
    await mounted.wrapper.get('[data-testid="developer-csp-draft"]').setValue("connect-src 'none';");
    await mounted.wrapper.get('[data-testid="developer-csp-save-meta"]').trigger('click');
    await flushPromises();
    expect(metaApi.saveDevelopmentMetaCspNotForSecurity).toHaveBeenCalledOnce();
    expect(metaApi.saveDevelopmentMetaCspNotForSecurity.mock.calls[0]?.[0].serialized).toBe("connect-src 'none';");
    expect(metaApi.savedSerialized.value).toBe("connect-src 'none';");
    expect(metaApi.saveDevelopmentMetaCspNotForSecurity.mock.calls[0]?.[0].isCurrent()).toBe(true);
    publishAddition({ serialized: "connect-src 'none';" });
    await mounted.wrapper.vm.$nextTick();
    expect(mounted.wrapper.get('[data-testid="developer-csp-installed-value"]').text()).toBe("connect-src 'none';");
    expect(mounted.wrapper.get('[data-testid="developer-csp-saved-value"]').text()).toBe("connect-src 'none';");
  });

  it('keeps all actual additions visible when editing and clearing the latest saved setting', async () => {
    const first = 'connect-src https://first.invalid;';
    const second = 'connect-src https://second.invalid;';
    publishAddition({ serialized: first });
    publishAddition({ serialized: second });
    metaApi.savedSerialized.value = second;
    using mounted = {
      wrapper: mount(DeveloperCspDiagnosticsContent),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await mounted.wrapper.get('[data-testid="developer-csp-preset-none"]').trigger('click');
    expect(mounted.wrapper.findAll('[data-testid="developer-csp-installed-value"]').map(pre => pre.text())).toEqual([first, second]);
    expect(mounted.wrapper.get('[data-testid="developer-csp-saved-value"]').text()).toBe(second);
    await mounted.wrapper.get('[data-testid="developer-csp-clear-meta"]').trigger('click');
    await flushPromises();
    expect(metaApi.clearDevelopmentMetaCspNotForSecurity).toHaveBeenCalledOnce();
    expect(metaApi.savedSerialized.value).toBeUndefined();
    expect(mounted.wrapper.find('[data-testid="developer-csp-saved-value"]').exists()).toBe(false);
    expect(mounted.wrapper.findAll('[data-testid="developer-csp-installed-value"]').map(pre => pre.text())).toEqual([first, second]);
    expect(mounted.wrapper.text()).toContain('Reload the page yourself');
    expect(metaApi.saveDevelopmentMetaCspNotForSecurity).not.toHaveBeenCalled();
  });

  it('omits frame-ancestors from development-meta presets while preserving arbitrary input exactly', async () => {
    using mounted = {
      wrapper: mount(DeveloperCspDiagnosticsContent),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    for (const id of ['local-only', 'curated']) {
      await mounted.wrapper.get(`[data-testid="developer-csp-preset-${id}"]`).trigger('click');
      expect(mounted.wrapper.get<HTMLTextAreaElement>('[data-testid="developer-csp-draft"]').element.value).not.toContain('frame-ancestors');
    }
    const custom = "frame-ancestors 'none'; connect-src https://custom.invalid;";
    await mounted.wrapper.get('[data-testid="developer-csp-draft"]').setValue(custom);
    await mounted.wrapper.get('[data-testid="developer-csp-save-meta"]').trigger('click');
    await flushPromises();
    expect(metaApi.saveDevelopmentMetaCspNotForSecurity.mock.calls[0]?.[0].serialized).toBe(custom);
    expect(metaApi.savedSerialized.value).toBe(custom);
  });

  it('saves the none preset as undefined while keeping already-added meta intact', async () => {
    const installed = "connect-src 'self';";
    publishAddition({ serialized: installed });
    metaApi.savedSerialized.value = installed;
    using mounted = {
      wrapper: mount(DeveloperCspDiagnosticsContent),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await mounted.wrapper.get('[data-testid="developer-csp-preset-none"]').trigger('click');
    await mounted.wrapper.get('[data-testid="developer-csp-save-meta"]').trigger('click');
    await flushPromises();
    expect(metaApi.saveDevelopmentMetaCspNotForSecurity.mock.calls[0]?.[0].serialized).toBeUndefined();
    expect(metaApi.saveDevelopmentMetaCspNotForSecurity.mock.calls[0]?.[0].isCurrent()).toBe(true);
    expect(metaApi.savedSerialized.value).toBeUndefined();
    expect(metaApi.snapshot.value.additions).toHaveLength(1);
    expect(mounted.wrapper.get('[data-testid="developer-csp-installed-value"]').text()).toBe(installed);
  });

  it('keeps HTTP headers, saved latest value, actual additions, and cached AST distinct without virtual state', async () => {
    const first = 'connect-src https://first.invalid;';
    const second = 'connect-src https://second.invalid;';
    publishAddition({ serialized: first });
    publishAddition({ serialized: second });
    metaApi.savedSerialized.value = second;
    const cached = snapshot.value.addedMetaParsed;
    using mounted = {
      wrapper: mount(DeveloperCspDiagnosticsContent),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await mounted.wrapper.get('[data-testid="developer-csp-draft"]').setValue('connect-src https://unsaved.invalid;');
    expect(mounted.wrapper.get('[data-testid="developer-csp-observed-enforce"]').text()).toBe("connect-src 'self';");
    expect(mounted.wrapper.get('[data-testid="developer-csp-saved-value"]').text()).toBe(second);
    expect(mounted.wrapper.findAll('[data-testid="developer-csp-installed-value"]').map(pre => pre.text())).toEqual([first, second]);
    await openParsed({ wrapper: mounted.wrapper });
    const parsed = JSON.parse(mounted.wrapper.get('[data-testid="developer-csp-parsed-json"]').text());
    expect(parsed.observed.enforce.serialized).toBe("connect-src 'self';");
    expect(parsed.savedDevelopmentMeta.serialized).toBe(second);
    expect(parsed.managedMeta.records.map((record: { policies: string[] }) => record.policies)).toEqual([[first], [second]]);
    expect(parsed.managedMeta.parsed).toEqual(cached);
    expect('simulated' in parsed).toBe(false);
    expect(metaApi.saveDevelopmentMetaCspNotForSecurity).not.toHaveBeenCalled();
    expect(metaApi.prepareResidentRecoveryAndApplySavedMetaForDevelopmentNotForSecurity).not.toHaveBeenCalled();
  });

  it('invalidates a pending save if the draft changes and returns to the same text', async () => {
    const completion = Promise.withResolvers<void>();
    metaApi.saveDevelopmentMetaCspNotForSecurity.mockImplementation(async ({ isCurrent }) => {
      metaApi.operation.value = 'saving';
      await completion.promise;
      if (!isCurrent()) {
        metaApi.operation.value = 'changed';
        return 'changed';
      }
      return 'saved';
    });
    using mounted = {
      wrapper: mount(DeveloperCspDiagnosticsContent),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await mounted.wrapper.get('[data-testid="developer-csp-preset-local-only"]').trigger('click');
    const selected = mounted.wrapper.get<HTMLTextAreaElement>('[data-testid="developer-csp-draft"]').element.value;
    await mounted.wrapper.get('[data-testid="developer-csp-save-meta"]').trigger('click');
    const guard = metaApi.saveDevelopmentMetaCspNotForSecurity.mock.calls[0]?.[0].isCurrent;
    expect(guard?.()).toBe(true);
    await mounted.wrapper.get('[data-testid="developer-csp-draft"]').setValue("connect-src 'none';");
    await mounted.wrapper.get('[data-testid="developer-csp-draft"]').setValue(selected);
    expect(guard?.()).toBe(false);
    completion.resolve();
    await flushPromises();
    expect(mounted.wrapper.get('[data-testid="developer-csp-meta-save-changed"]').text()).toContain('changed');
    expect(metaApi.savedSerialized.value).toBeUndefined();
  });

  it('does not save an old draft after its storage changes', async () => {
    using mounted = {
      wrapper: mount(DeveloperCspDiagnosticsContent),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await mounted.wrapper.get('[data-testid="developer-csp-preset-local-only"]').trigger('click');
    storageCurrent = false;
    await mounted.wrapper.get('[data-testid="developer-csp-save-meta"]').trigger('click');
    await flushPromises();
    expect(metaApi.savedSerialized.value).toBeUndefined();
    expect(mounted.wrapper.get('[data-testid="developer-csp-meta-save-changed"]').text()).toContain('changed');
  });

  it('reports persistence failure while leaving existing actual meta unchanged', async () => {
    const installed = "connect-src 'self';";
    publishAddition({ serialized: installed });
    metaApi.saveDevelopmentMetaCspNotForSecurity.mockImplementation(async () => {
      metaApi.operation.value = 'failed';
      return 'failed';
    });
    using mounted = {
      wrapper: mount(DeveloperCspDiagnosticsContent),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await mounted.wrapper.get('[data-testid="developer-csp-preset-local-only"]').trigger('click');
    await mounted.wrapper.get('[data-testid="developer-csp-save-meta"]').trigger('click');
    await flushPromises();
    expect(mounted.wrapper.get('[data-testid="developer-csp-meta-save-failed"]').text()).toContain('could not be saved');
    expect(metaApi.savedSerialized.value).toBeUndefined();
    expect(mounted.wrapper.get('[data-testid="developer-csp-installed-value"]').text()).toBe(installed);
  });

  it('bounds a restored oversized saved value without turning its prefix into an editable setting', async () => {
    const saved = 'x'.repeat(80_000);
    metaApi.savedSerialized.value = saved;
    using mounted = {
      wrapper: mount(DeveloperCspDiagnosticsContent),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    expect(mounted.wrapper.get('[data-testid="developer-csp-saved-value"]').text()).toHaveLength(65_536);
    expect(mounted.wrapper.get('[data-testid="developer-csp-saved-truncated"]').text()).toContain('80000');
    expect(mounted.wrapper.get<HTMLTextAreaElement>('[data-testid="developer-csp-draft"]').element.value).toBe('');
    await openParsed({ wrapper: mounted.wrapper });
    const parsed = JSON.parse(mounted.wrapper.get('[data-testid="developer-csp-parsed-json"]').text());
    expect(parsed.savedDevelopmentMeta.serialized).toHaveLength(65_536);
    expect(parsed.savedDevelopmentMeta.originalLength).toBe(80_000);
    expect(parsed.savedDevelopmentMeta.capture).toBe('truncated');
    expect(metaApi.savedSerialized.value).toBe(saved);
  });

  it('shows a bounded prefix of many additions and marks incomplete diagnostics without dropping raw records', async () => {
    const additions = Array.from({ length: 40 }, (_, index) => ({ serialized: `connect-src https://a${index}.invalid;`, policies: [`connect-src https://a${index}.invalid;`], source: 'developer-action' as const }));
    metaApi.snapshot.value = { ...metaApi.snapshot.value, additions, diagnostics: 'unavailable' };
    snapshot.value = { ...snapshot.value, addedMetaParsed: undefined };
    using mounted = {
      wrapper: mount(DeveloperCspDiagnosticsContent),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    expect(mounted.wrapper.findAll('[data-testid="developer-csp-meta-record"]')).toHaveLength(8);
    expect(mounted.wrapper.get('[data-testid="developer-csp-managed-truncated"]').text()).toContain('40');
    expect(mounted.wrapper.find('[data-testid="developer-csp-meta-diagnostics-unavailable"]').exists()).toBe(true);
    await openParsed({ wrapper: mounted.wrapper });
    const parsed = JSON.parse(mounted.wrapper.get('[data-testid="developer-csp-parsed-json"]').text());
    expect(parsed.managedMeta.records).toHaveLength(8);
    expect(parsed.managedMeta.originalCount).toBe(40);
    expect(parsed.managedMeta.capture).toBe('truncated');
    expect(parsed.managedMeta.parsedCapture).toBe('unavailable');
    expect(metaApi.snapshot.value.additions).toHaveLength(40);
  });

  it('lists only successfully appended policy values after a partial addition', async () => {
    const applied = "connect-src 'self';";
    metaApi.snapshot.value = { ...metaApi.snapshot.value, preparation: 'unavailable', reason: 'installation-failed', installation: { kind: 'partly-added', serialized: `${applied}, img-src https://not-added.invalid;`, policies: [applied], source: 'developer-action' }, additions: [{ serialized: `${applied}, img-src https://not-added.invalid;`, policies: [applied], source: 'developer-action' }], diagnostics: 'unavailable' };
    using mounted = {
      wrapper: mount(DeveloperCspDiagnosticsContent),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    expect(mounted.wrapper.get('[data-testid="developer-csp-installed-value"]').text()).toBe(applied);
    expect(mounted.wrapper.get('[data-testid="developer-csp-installed-value"]').text()).not.toContain('not-added.invalid');
  });

  it('separates page meta records from a broker that has not become ready without creating an iframe', async () => {
    const pagePolicy = "connect-src 'self';";
    publishAddition({ serialized: pagePolicy });
    using mounted = {
      wrapper: mount(DeveloperCspDiagnosticsContent),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    expect(mounted.wrapper.get('[data-testid="developer-csp-installed-value"]').text()).toBe(pagePolicy);
    const broker = mounted.wrapper.get('[data-testid="developer-csp-privacy-fetch"]');
    expect(broker.get('[data-testid="developer-csp-privacy-fetch-status"]').text()).toBe('Not ready');
    expect(broker.text()).toContain('has not been created or is still preparing');
    expect(broker.find('[data-testid="developer-csp-privacy-fetch-prefix"]').exists()).toBe(false);
    expect(mounted.wrapper.get('[data-testid="developer-csp-managed-meta"]').element.hasAttribute('open')).toBe(false);
    await mounted.wrapper.get('[data-testid="developer-csp-preset-local-only"]').trigger('click');
    await mounted.wrapper.get('[data-testid="developer-csp-save-meta"]').trigger('click');
    await flushPromises();
    expect(mounted.wrapper.find('iframe').exists()).toBe(false);
    expect(metaApi.prepareResidentRecoveryAndApplySavedMetaForDevelopmentNotForSecurity).not.toHaveBeenCalled();
    expect(broker.get('[data-testid="developer-csp-privacy-fetch-status"]').text()).toBe('Not ready');
  });

  it.each([
    { kind: 'pending', confirmed: 1, label: 'Awaiting confirmation' },
    { kind: 'confirmed', confirmed: 3, label: 'Additions confirmed' },
    { kind: 'unavailable', confirmed: 1, label: 'Confirmation unavailable' },
  ] as const)('shows only the acknowledged broker prefix for $kind without changing configuration actions', ({ kind, confirmed, label }) => {
    for (const host of ['one', 'two', 'three']) {
      publishAddition({ serialized: `connect-src https://${host}.invalid;` });
    }
    metaApi.savedSerialized.value = 'connect-src https://three.invalid;';
    metaApi.snapshot.value = { ...metaApi.snapshot.value, privacyBroker: { kind, sessionId: 'session-1', syncId: 'sync-2', requestedPolicyCount: 3, confirmedPolicyCount: confirmed, reason: kind === 'unavailable' ? 'installation-failed' : undefined } };
    using mounted = {
      wrapper: mount(DeveloperCspDiagnosticsContent),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    const broker = mounted.wrapper.get('[data-testid="developer-csp-privacy-fetch"]');
    expect(broker.get('[data-testid="developer-csp-privacy-fetch-status"]').text()).toBe(label);
    expect(broker.get('[data-testid="developer-csp-privacy-fetch-prefix"]').text()).toBe(`Confirmed meta prefix: ${confirmed} of 3.`);
    expect(broker.text()).toContain('separate Workers');
    expect(broker.text()).toContain('directives unsupported in meta');
    expect(mounted.wrapper.findAll('[data-testid="developer-csp-installed-value"]')).toHaveLength(3);
    expect(mounted.wrapper.get('[data-testid="developer-csp-save-meta"]').attributes('disabled')).toBeUndefined();
    expect(mounted.wrapper.get('[data-testid="developer-csp-clear-meta"]').attributes('disabled')).toBeUndefined();
    if (kind !== 'confirmed') {
      expect(broker.get('[data-testid="developer-csp-privacy-fetch-status"]').text()).not.toBe('Additions confirmed');
    }
  });

  it('keeps a new broker sync pending until its own state confirms it and records that state only in explicit JSON', async () => {
    publishAddition({ serialized: "connect-src 'self';" });
    metaApi.snapshot.value = { ...metaApi.snapshot.value, privacyBroker: { kind: 'confirmed', sessionId: 'session-1', syncId: 'sync-1', requestedPolicyCount: 1, confirmedPolicyCount: 1, reason: undefined } };
    using mounted = {
      wrapper: mount(DeveloperCspDiagnosticsContent),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    publishAddition({ serialized: "img-src 'self';" });
    metaApi.snapshot.value = { ...metaApi.snapshot.value, privacyBroker: { kind: 'pending', sessionId: 'session-1', syncId: 'sync-2', requestedPolicyCount: 2, confirmedPolicyCount: 1, reason: undefined } };
    await mounted.wrapper.vm.$nextTick();
    expect(mounted.wrapper.get('[data-testid="developer-csp-privacy-fetch-status"]').text()).toBe('Awaiting confirmation');
    expect(mounted.wrapper.get('[data-testid="developer-csp-privacy-fetch-prefix"]').text()).toBe('Confirmed meta prefix: 1 of 2.');
    expect(mounted.wrapper.find('[data-testid="developer-csp-parsed-json"]').exists()).toBe(false);
    await openParsed({ wrapper: mounted.wrapper });
    const parsed = JSON.parse(mounted.wrapper.get('[data-testid="developer-csp-parsed-json"]').text());
    expect(parsed.privacyFetch).toEqual(metaApi.snapshot.value.privacyBroker);
    expect(parsed.managedMeta.records).toHaveLength(2);
    metaApi.snapshot.value = { ...metaApi.snapshot.value, privacyBroker: { ...metaApi.snapshot.value.privacyBroker, kind: 'unavailable', reason: 'send-failed' } };
    await mounted.wrapper.vm.$nextTick();
    expect(mounted.wrapper.get('[data-testid="developer-csp-privacy-fetch-status"]').text()).toBe('Confirmation unavailable');
    expect(mounted.wrapper.get('[data-testid="developer-csp-privacy-fetch-prefix"]').text()).toBe('Confirmed meta prefix: 1 of 2.');
    expect(mounted.wrapper.findAll('[data-testid="developer-csp-installed-value"]')).toHaveLength(2);
  });

  it('does not replace a pending edit when the observed request settles', async () => {
    snapshot.value = { ...snapshot.value, observation: { kind: 'pending' } };
    using mounted = {
      wrapper: mount(DeveloperCspDiagnosticsContent),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await mounted.wrapper.get('[data-testid="developer-csp-draft"]').setValue("img-src 'none';");
    snapshot.value = { ...snapshot.value, observation: observation({ serialized: "connect-src 'self';" }) };
    await mounted.wrapper.vm.$nextTick();
    expect(mounted.wrapper.get<HTMLTextAreaElement>('[data-testid="developer-csp-draft"]').element.value).toBe("img-src 'none';");
  });

  it.each(['pending', 'unavailable'] as const)('does not describe an unknown %s header as absent or copy an empty value', async kind => {
    snapshot.value = { ...snapshot.value, observation: kind === 'pending' ? { kind: 'pending' } : { kind: 'unavailable', reason: 'request-failed', capturedHeaders: undefined }, connectionSummary: undefined };
    using mounted = {
      wrapper: mount(DeveloperCspDiagnosticsContent),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    const active = mounted.wrapper.get('[data-testid="developer-csp-observed-headers"]');
    expect(active.text()).not.toContain('No header');
    expect(active.find('[data-testid="developer-csp-observed-enforce"]').exists()).toBe(false);
    expect(active.get('[data-testid="developer-csp-copy-header"]').attributes('disabled')).toBeDefined();
  });

  it('shows captured raw text and truncation after a parse failure without exposing partial AST', () => {
    snapshot.value = {
      ...snapshot.value,
      observation: {
        kind: 'unavailable',
        reason: 'parse-failed',
        capturedHeaders: { enforce: { serialized: "connect-src 'self'; truncated", originalLength: 90_000, capture: 'truncated' }, reportOnly: undefined },
      },
      connectionSummary: undefined,
    };
    using mounted = {
      wrapper: mount(DeveloperCspDiagnosticsContent),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    const active = mounted.wrapper.get('[data-testid="developer-csp-observed-headers"]');
    expect(active.text()).toContain('parse-failed');
    expect(active.text()).toContain('truncated');
    expect(active.text()).toContain('90000');
    expect(active.get('[data-testid="developer-csp-observed-enforce"]').text()).toBe("connect-src 'self'; truncated");
    expect(active.get('[data-testid="developer-csp-copy-header"]').attributes('disabled')).toBeUndefined();
    expect('enforce' in snapshot.value.observation).toBe(false);
  });

  it('distinguishes a present empty header from a header known to be missing', () => {
    const parsed = parseCsp({ serialized: '' });
    if (parsed.kind !== 'parsed') {
      throw new Error('Empty CSP fixture must be parsed');
    }
    snapshot.value = { ...snapshot.value, observation: { kind: 'observed', documentUrl: 'https://app.invalid/', enforce: { serialized: '', parsed: parsed.value }, reportOnly: undefined } };
    using empty = {
      wrapper: mount(DeveloperCspDiagnosticsContent),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    const active = empty.wrapper.get('[data-testid="developer-csp-observed-headers"]');
    expect(active.get('[data-testid="developer-csp-observed-enforce"]').text()).toBe('');
    expect(active.find('[data-testid="developer-csp-missing-header"]').exists()).toBe(false);
    expect(active.get('[data-testid="developer-csp-copy-header"]').attributes('disabled')).toBeUndefined();

    snapshot.value = { ...snapshot.value, observation: observation({ serialized: '' }) };
    using missing = {
      wrapper: mount(DeveloperCspDiagnosticsContent),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    expect(missing.wrapper.get('[data-testid="developer-csp-missing-header"]').text()).toBe('No header');
    expect(missing.wrapper.get('[data-testid="developer-csp-copy-header"]').attributes('disabled')).toBeDefined();
  });
});
