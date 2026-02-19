import { describe, it, expect, beforeEach } from 'vitest';
import { useSettings } from './useSettings';

describe('useSettings - Search Volatile State', () => {
  const {
    searchPreviewMode,
    searchContextSize,
    setSearchPreviewMode,
    setSearchContextSize
  } = useSettings();

  beforeEach(() => {
    // Reset to defaults manually as useSettings uses global state
    setSearchPreviewMode({ mode: 'always' });
    setSearchContextSize(2);
  });

  it('should update searchPreviewMode', () => {
    expect(searchPreviewMode.value).toBe('always');
    setSearchPreviewMode({ mode: 'peek' });
    expect(searchPreviewMode.value).toBe('peek');
    setSearchPreviewMode({ mode: 'disabled' });
    expect(searchPreviewMode.value).toBe('disabled');
  });

  it('should update searchContextSize', () => {
    expect(searchContextSize.value).toBe(2);
    setSearchContextSize(5);
    expect(searchContextSize.value).toBe(5);
    setSearchContextSize(Infinity);
    expect(searchContextSize.value).toBe(Infinity);
  });
});
