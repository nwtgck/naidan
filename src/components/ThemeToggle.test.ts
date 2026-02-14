import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount } from '@vue/test-utils';
import ThemeToggle from './ThemeToggle.vue';
import { useTheme } from '../composables/useTheme';

// Mock useTheme
vi.mock('../composables/useTheme', () => ({
  useTheme: vi.fn(),
}));

describe('ThemeToggle.vue', () => {
  const setTheme = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders correctly with default state', () => {
    (useTheme as Mock).mockReturnValue({
      themeMode: 'system',
      setTheme,
    });

    const wrapper = mount(ThemeToggle);

    // Check if all buttons are present
    const buttons = wrapper.findAll('button');
    expect(buttons).toHaveLength(3);

    // Check titles
    expect(buttons[0]!.attributes('title')).toBe('Light Mode');
    expect(buttons[1]!.attributes('title')).toBe('Dark Mode');
    expect(buttons[2]!.attributes('title')).toBe('System Mode');
  });

  it('calls setTheme when buttons are clicked', async () => {
    (useTheme as Mock).mockReturnValue({
      themeMode: 'system',
      setTheme,
    });

    const wrapper = mount(ThemeToggle);
    const buttons = wrapper.findAll('button');

    await buttons[0]!.trigger('click');
    expect(setTheme).toHaveBeenCalledWith('light');

    await buttons[1]!.trigger('click');
    expect(setTheme).toHaveBeenCalledWith('dark');

    await buttons[2]!.trigger('click');
    expect(setTheme).toHaveBeenCalledWith('system');
  });

  it('applies the correct transform style based on themeMode', () => {
    // Test Light Mode transform
    (useTheme as Mock).mockReturnValue({ themeMode: 'light', setTheme });
    const w1 = mount(ThemeToggle);
    const indicator1 = w1.get('[data-testid="theme-indicator"]');
    expect(indicator1.attributes('style')).toContain('transform: translateX(0)');

    // Test Dark Mode transform
    (useTheme as Mock).mockReturnValue({ themeMode: 'dark', setTheme });
    const w2 = mount(ThemeToggle);
    const indicator2 = w2.get('[data-testid="theme-indicator"]');
    expect(indicator2.attributes('style')).toContain('transform: translateX(100%)');

    // Test System Mode transform
    (useTheme as Mock).mockReturnValue({ themeMode: 'system', setTheme });
    const w3 = mount(ThemeToggle);
    const indicator3 = w3.get('[data-testid="theme-indicator"]');
    expect(indicator3.attributes('style')).toContain('transform: translateX(200%)');
  });

  it('applies active classes based on themeMode', () => {
    (useTheme as Mock).mockReturnValue({
      themeMode: 'dark',
      setTheme,
    });

    const wrapper = mount(ThemeToggle);
    const buttons = wrapper.findAll('button');

    // Light button should be inactive
    expect(buttons[0]!.classes()).toContain('text-gray-400');

    // Dark button should be active
    expect(buttons[1]!.classes()).toContain('text-blue-600');
    expect(buttons[1]!.classes()).toContain('dark:text-blue-400');

    // System button should be inactive
    expect(buttons[2]!.classes()).toContain('text-gray-400');
  });

  it('maintains solid non-transparent background classes', () => {
    (useTheme as Mock).mockReturnValue({
      themeMode: 'system',
      setTheme,
    });

    const wrapper = mount(ThemeToggle);
    const container = wrapper.find('.relative.flex');

    // Check for non-transparent background classes
    expect(container.classes()).toContain('bg-gray-200');
    expect(container.classes()).toContain('dark:bg-black');

    // Ensure no alpha/opacity classes are present in background
    const hasAlpha = container.classes().some(c => c.includes('/') && c.startsWith('bg-'));
    expect(hasAlpha).toBe(false);
  });
});
