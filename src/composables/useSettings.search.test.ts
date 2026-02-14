import { describe, it, expect, beforeEach } from 'vitest';
import { useSettings } from './useSettings';

describe('useSettings - Search Volatile State', () => {
  const {
    searchPreviewEnabled,
    searchContextSize,
    setSearchPreviewEnabled,
    setSearchContextSize
  } = useSettings();

  beforeEach(() => {
    // Reset to defaults manually as useSettings uses global state
    setSearchPreviewEnabled(true);
    setSearchContextSize(2);
  });

  it('should update searchPreviewEnabled', () => {
    expect(searchPreviewEnabled.value).toBe(true);
    setSearchPreviewEnabled(false);
    expect(searchPreviewEnabled.value).toBe(false);
  });

  it('should update searchContextSize', () => {
    expect(searchContextSize.value).toBe(2);
    setSearchContextSize(5);
    expect(searchContextSize.value).toBe(5);
    setSearchContextSize(Infinity);
    expect(searchContextSize.value).toBe(Infinity);
  });
});
