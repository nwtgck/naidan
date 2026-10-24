import { afterEach, expect, it } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import SettingsSelectScope from './SettingsSelectScope.vue';
import SettingsFormSelect from './SettingsFormSelect.vue';
import SettingsSelect from './SettingsSelect.vue';
import ImageSettingsSection from '@/features/image-generation/components/ImageSettingsSection.vue';

enableAutoUnmount(afterEach);

afterEach(() => {
  document.body.innerHTML = '';
});

const Host = defineComponent({
  components: { SettingsSelectScope, SettingsFormSelect, ImageSettingsSection },
  props: { active: Boolean, localActive: Boolean, detailsOpen: Boolean, disabled: Boolean },
  data: () => ({ value: 128, draft: 'Keep this draft', options: [{ value: 128, label: '128 px' }, { value: 256, label: '256 px' }] }),
  template: '<div><button ref="outside" data-testid="outside">Other panel</button><SettingsSelectScope :active="active" :return-focus="$refs.outside"><ImageSettingsSection :open="detailsOpen" title="Settings" :summary="undefined"><button ref="local" data-testid="local">Details</button><SettingsSelectScope :active="localActive" :return-focus="$refs.local"><SettingsFormSelect v-model="value" :options="options" label="Size" :disabled="disabled" data-testid="size" /><input v-model="draft" data-testid="draft" /></SettingsSelectScope></ImageSettingsSection></SettingsSelectScope></div>',
});

it.each(['active', 'localActive', 'detailsOpen'] as const)('closes a portaled menu when %s closes, preserving its form and ignoring old options', async boundary => {
  const wrapper = mount(Host, { attachTo: document.body, props: { active: true, localActive: true, detailsOpen: true, disabled: false } });
  const input = wrapper.get<HTMLInputElement>('[data-testid="draft"]').element;
  await wrapper.get('[data-testid="size"]').trigger('click');
  const option = document.querySelector<HTMLButtonElement>('[data-testid="settings-select-option-256"]');
  expect(option).not.toBeNull();
  await wrapper.setProps({ [boundary]: false });
  option?.click();
  expect(wrapper.vm.value).toBe(128);
  expect(wrapper.get('[data-testid="size"]').attributes('aria-expanded')).toBe('false');
  expect(wrapper.get('[data-testid="draft"]').element).toBe(input);
  expect(input.value).toBe('Keep this draft');
  expect(document.activeElement).toBe(boundary === 'active' ? wrapper.get('[data-testid="outside"]').element : boundary === 'localActive' ? wrapper.get('[data-testid="local"]').element : wrapper.get('summary').element);
  await wrapper.get('[data-testid="size"]').trigger('click');
  expect(wrapper.get('[data-testid="size"]').attributes('aria-expanded')).toBe('false');
  await wrapper.setProps({ [boundary]: true });
  await wrapper.get('[data-testid="size"]').trigger('click');
  document.querySelector<HTMLButtonElement>('[data-testid="settings-select-option-256"]')?.click();
  await nextTick();
  expect(wrapper.vm.value).toBe(256);
  expect(typeof wrapper.vm.value).toBe('number');
});

it('keeps runtime option validation and disabled checks in the typed form adapter', async () => {
  const wrapper = mount(Host, { props: { active: true, localActive: true, detailsOpen: true, disabled: false } });
  const select = wrapper.getComponent(SettingsSelect);
  select.vm.$emit('update:modelValue', 'unknown');
  await nextTick();
  expect(wrapper.vm.value).toBe(128);
  await wrapper.setProps({ disabled: true });
  select.vm.$emit('update:modelValue', '256');
  await nextTick();
  expect(wrapper.vm.value).toBe(128);
});
