import { describe, it, expect } from 'vitest';
import { useLayout } from './useLayout';

describe('useLayout editor mode preference', () => {
  it('should maintain preferredEditorMode in memory across different hook calls', () => {
    const layout1 = useLayout();
    const layout2 = useLayout();

    // Default should be 'advanced'
    expect(layout1.preferredEditorMode.value).toBe('advanced');
    expect(layout2.preferredEditorMode.value).toBe('advanced');

    // Update in one instance
    layout1.setPreferredEditorMode({ mode: 'textarea' });

    // Should be reflected in both instances (since ref is outside the function)
    expect(layout1.preferredEditorMode.value).toBe('textarea');
    expect(layout2.preferredEditorMode.value).toBe('textarea');

    // Switch back
    layout2.setPreferredEditorMode({ mode: 'advanced' });
    expect(layout1.preferredEditorMode.value).toBe('advanced');
  });
});
