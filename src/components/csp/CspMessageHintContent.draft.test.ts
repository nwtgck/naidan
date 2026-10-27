import { mount, enableAutoUnmount } from '@vue/test-utils';
import { shallowRef, type Ref } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CspHintTarget } from '@/logic/csp-message-hints/types';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import CspMessageHintContent from './CspMessageHintContent.vue';

const fixture = vi.hoisted(() => {
  const targets: Array<Readonly<Ref<CspHintTarget | undefined>>> = [];
  return { targets };
});
vi.mock('@/composables/useCspMessageHintsOnly', () => ({
  useCspMessageHintsOnly: ({ target }: { target: Readonly<Ref<CspHintTarget | undefined>> }) => {
    fixture.targets.push(target);
    return shallowRef(undefined);
  },
}));

enableAutoUnmount(afterEach);

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  fixture.targets.length = 0;
});

it.each(['', 'h', 'ht', 'htt', 'http', 'https', 'http:', 'https:', 'http:/', 'https:/', 'http://', 'https://', ' HTtPS:/ ', '//', '///', 'https:///', 'http://l', 'https://myhost', 'http://myhost:8080/v1.0', '//myhost'])('does not invent a destination from incomplete connection input %s', async endpoint => {
  const target: CspHintTarget = { kind: 'connection', endpoint, apiPath: '/models' };
  const wrapper = mount(CspMessageHintContent, { props: { target, presentation: 'compact', activityForDisplayOnly: undefined } });
  expect(fixture.targets[0]?.value).toBeUndefined();
  await wrapper.setProps({ presentation: 'error' });
  expect(fixture.targets[0]?.value).toEqual(target);
  await wrapper.setProps({ presentation: 'error-details' });
  expect(fixture.targets[0]?.value).toEqual(target);
  await wrapper.setProps({ presentation: 'compact' });
  expect(fixture.targets[0]?.value).toBeUndefined();
});

it.each(['http://localhost', 'https://localhost', 'http://myhost.', 'https://l.l', 'http://127.0.0.1', 'https://[::1]:11434', 'localhost:11434', 'http.example', '/ollama-proxy', '//localhost:11434', '//myhost.', '/', 'relative-api', 'https://api.example/v1'])('preserves an existing connection destination %s', endpoint => {
  const target: CspHintTarget = { kind: 'connection', endpoint, apiPath: '/api/ps' };
  mount(CspMessageHintContent, { props: { target, presentation: 'compact', activityForDisplayOnly: undefined } });
  expect(fixture.targets[0]?.value).toEqual(target);
});

it.each([undefined, '', 'http', 'https://', 'http:localhost', 'https:localhost', 'http://l', 'https://myhost', '/relay', 'not a URL', 'ftp://relay.example'])('does not resolve an unready relay draft %s against the page', async url => {
  const target: CspHintTarget = { kind: 'relay', url };
  const wrapper = mount(CspMessageHintContent, { props: { target, presentation: 'compact', activityForDisplayOnly: undefined } });
  expect(fixture.targets[0]?.value).toBeUndefined();
  await wrapper.setProps({ presentation: 'error' });
  expect(fixture.targets[0]?.value).toEqual(target);
});

it.each(['http://localhost:8787', 'https://localhost:8787', 'http://myhost.', 'https://127.0.0.1:8787', 'http://[::1]:8787', 'https://relay.example'])('keeps a valid relay destination %s', url => {
  const target: CspHintTarget = { kind: 'relay', url };
  mount(CspMessageHintContent, { props: { target, presentation: 'compact', activityForDisplayOnly: undefined } });
  expect(fixture.targets[0]?.value).toEqual(target);
});

it('leaves fixed Hugging Face preflight targets intact', () => {
  const target: CspHintTarget = { kind: 'huggingface-metadata' };
  mount(CspMessageHintContent, { props: { target, presentation: 'compact', activityForDisplayOnly: undefined } });
  expect(fixture.targets[0]?.value).toEqual(target);
});

it('keeps oversized inputs out of preflight processing', () => {
  const targets: CspHintTarget[] = [
    { kind: 'connection', endpoint: 'x'.repeat(4_097), apiPath: '/models' },
    { kind: 'relay', url: 'https://' + 'x'.repeat(4_097) },
  ];
  for (const target of targets) {
    mount(CspMessageHintContent, { props: { target, presentation: 'compact', activityForDisplayOnly: undefined } });
    expect(fixture.targets.at(-1)?.value).toBeUndefined();
  }
});
