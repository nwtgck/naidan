import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ToolConfigHierarchySettings from './ToolConfigHierarchySettings.vue';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import type { ToolConfig } from '@/01-models/tool';

const featureState = vi.hoisted(() => ({ weshEnabled: true }));

vi.mock('@/composables/useFeatureFlags', () => ({
  useFeatureFlags: () => ({
    isFeatureEnabled: ({ feature }: { feature: string }) => feature !== 'wesh_tool' || featureState.weshEnabled,
  }),
}));

vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    settings: {
      value: {
        storageType: 'opfs',
      },
    },
  }),
}));

vi.mock('lucide-vue-next', () => ({
  BookOpenIcon: { template: '<span />' },
  CalculatorIcon: { template: '<span />' },
  InfoIcon: { template: '<span />' },
  ListIcon: { template: '<span />' },
  RotateCcwIcon: { template: '<span />' },
  TerminalIcon: { template: '<span />' },
}));

const defaults: ToolConfig[] = [
  { key: 'builtin.calculator', status: 'disabled' },
  { key: 'builtin.choices', status: 'disabled' },
  { key: 'builtin.wikipedia', status: 'disabled' },
  {
    key: 'builtin.wesh',
    status: 'disabled',
    naidanSysfs: { accessScope: 'none' },
  },
];

const inheritanceLabels = {
  'builtin.calculator': 'Use global',
  'builtin.choices': 'Use global',
  'builtin.wikipedia': 'Use global',
  'builtin.wesh': 'Use global',
} as const;

function mountSettings({
  scope = 'chat_group',
  toolConfigs,
  effectiveToolConfigs = defaults,
  isEditable = true,
  inheritanceLabelByKey = scope === 'chat' ? inheritanceLabels : undefined,
}: {
  scope?: 'global' | 'chat_group' | 'chat',
  toolConfigs?: ToolConfig[],
  effectiveToolConfigs?: ToolConfig[],
  isEditable?: boolean,
  inheritanceLabelByKey?: typeof inheritanceLabels,
} = {}) {
  return mount(ToolConfigHierarchySettings, {
    props: {
      scope,
      toolConfigs,
      effectiveToolConfigs,
      inheritanceLabelByKey,
      isEditable,
    },
  });
}

function withToolConfig({
  key,
  config,
}: {
  key: ToolConfig['key'],
  config: ToolConfig,
}): ToolConfig[] {
  return defaults.map((current) => current.key === key ? config : current);
}

describe('ToolConfigHierarchySettings', () => {
  beforeEach(() => {
    featureState.weshEnabled = true;
  });

  it('uses one effective-state toggle and keeps a separated fixed reset slot', async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    const inheritedWrapper = mountSettings();
    const inheritedToggle = inheritedWrapper.get('[data-testid="tool-config-builtin.calculator-toggle"]');

    expect(inheritedToggle.attributes('aria-checked')).toBe('false');
    expect(inheritedWrapper.get('[data-testid="tool-config-card-builtin.calculator"]').classes()).toContain('h-[52px]');
    expect(inheritedWrapper.get('[data-testid="tool-config-builtin.calculator-control-stack"]').classes()).toContain('gap-2');
    expect(inheritedWrapper.find('[data-testid="tool-config-builtin.calculator-inherit"]').exists()).toBe(false);
    expect(inheritedWrapper.text()).not.toContain('Inherited from Global Settings');

    await inheritedToggle.trigger('click');
    expect(inheritedWrapper.emitted('set-status')?.[0]).toEqual([{
      key: 'builtin.calculator',
      status: 'enabled',
    }]);

    const explicitWrapper = mountSettings({
      toolConfigs: [{ key: 'builtin.calculator', status: 'enabled' }],
      effectiveToolConfigs: withToolConfig({
        key: 'builtin.calculator',
        config: { key: 'builtin.calculator', status: 'enabled' },
      }),
    });

    expect(explicitWrapper.get('[data-testid="tool-config-builtin.calculator-toggle"]').attributes('aria-checked')).toBe('true');
    expect(explicitWrapper.get('[data-testid="tool-config-builtin.calculator-inherit"]').text()).toBe('Use global');

    await explicitWrapper.get('[data-testid="tool-config-builtin.calculator-inherit"]').trigger('click');
    expect(explicitWrapper.emitted('reset-tool')?.[0]).toEqual([{ key: 'builtin.calculator' }]);
  });

  it('uses the same two-state toggle in the compact Global UI', () => {
    const wrapper = mountSettings({ scope: 'global' });

    expect(wrapper.get('[data-testid="tool-config-builtin.calculator-toggle"]').attributes('aria-checked')).toBe('false');
    expect(wrapper.get('[data-testid="tool-config-card-builtin.calculator"]').classes()).toContain('h-[52px]');
    expect(wrapper.find('[data-testid="tool-config-builtin.calculator-inherit"]').exists()).toBe(false);
  });


  it('does not show a chat-level bulk reset action', () => {
    const wrapper = mountSettings({
      scope: 'chat',
      toolConfigs: [{ key: 'builtin.calculator', status: 'enabled' }],
    });

    expect(wrapper.find('[data-testid="tool-config-reset-all"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Reset chat overrides');
  });

  it('shows Wikipedia as effectively Off when its Shell dependency is unavailable', () => {
    const effectiveToolConfigs = withToolConfig({
      key: 'builtin.wikipedia',
      config: { key: 'builtin.wikipedia', status: 'enabled' },
    });
    const wrapper = mountSettings({
      toolConfigs: [{ key: 'builtin.wikipedia', status: 'enabled' }],
      effectiveToolConfigs,
    });

    expect(wrapper.get('[data-testid="tool-config-builtin.wikipedia-toggle"]').attributes('aria-checked')).toBe('false');
  });

  it('disables all controls and explains persistence when the layer is read-only', () => {
    const wrapper = mountSettings({ isEditable: false });

    expect(wrapper.find('[data-testid="tool-config-read-only-note"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="tool-config-builtin.calculator-toggle"]').attributes('disabled')).toBeDefined();
  });

  it('hides Shell controls while the Shell feature is disabled', () => {
    featureState.weshEnabled = false;
    const wrapper = mountSettings();

    expect(wrapper.find('[data-testid="tool-config-card-builtin.wesh"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="hierarchical-wesh-settings"]').exists()).toBe(false);
  });

  it('separates the Shell mount toggle from its visibility selection', async () => {
    const effectiveToolConfigs = withToolConfig({
      key: 'builtin.wesh',
      config: {
        key: 'builtin.wesh',
        status: 'enabled',
        naidanSysfs: { accessScope: 'current_chat_only' },
      },
    });
    const wrapper = mountSettings({ effectiveToolConfigs });

    expect(wrapper.get('[data-testid="hierarchical-wesh-mount-toggle"]').attributes('aria-checked')).toBe('true');
    expect(wrapper.get('[data-testid="wesh-storage-mode-note"]').text()).toContain('Writable /tmp');

    await wrapper.get('[data-testid="hierarchical-wesh-mount-toggle"]').trigger('click');
    expect(wrapper.emitted('set-wesh-access-scope')?.[0]).toEqual([{
      accessScope: 'none',
    }]);

    await wrapper.get('[data-testid="hierarchical-wesh-access-scope"]').setValue('main_chats');
    expect(wrapper.emitted('set-wesh-access-scope')?.[1]).toEqual([{
      accessScope: 'main_chats',
    }]);
  });
});
