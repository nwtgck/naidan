import { defineComponent, h, type PropType } from 'vue';

/** Owner tests exercise controlled values/events; SettingsSelect tests cover the real popup. */
export const SettingsSelectStub = defineComponent({
  name: 'SettingsSelect',
  props: {
    modelValue: { type: String, required: true },
    options: { type: Array as PropType<readonly { value: string, label: string | undefined, source?: { label: string | undefined, description: string | undefined }, disabled?: boolean }[]>, required: true },
    disabled: Boolean,
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    return () => h('select', {
      value: props.modelValue,
      disabled: props.disabled,
      onChange: (event: Event) => emit('update:modelValue', (event.target as HTMLSelectElement).value),
    }, props.options.map(option => h('option', { value: option.value, disabled: option.disabled }, option.source?.label ? `${option.source.label}: ${option.label}` : option.label)));
  },
});
export const TEST_ONLY = {
};
