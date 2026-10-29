export function LlamaCppBrowserRuntimeSettings__vision_storage_status({ capability, preference, selected }: { capability: 'available' | 'absent' | 'incompatible' | undefined, preference: 'legacy-expand' | 'retain-checked' | undefined, selected: 'legacy-expand' | 'retain-checked' | undefined }): string {
  switch (capability) {
  case undefined: return 'Checking runtime storage support.';
  case 'incompatible': return 'This runtime storage API is incompatible. No other mode is used automatically.';
  case 'absent':
    switch (preference) {
    case undefined: return 'Default: legacy-expand. This runtime has no retained-storage API.';
    case 'legacy-expand': return 'Selected: legacy-expand, using the existing runtime path.';
    case 'retain-checked': return 'retain-checked is selected but unavailable in this runtime. Choose legacy expansion or reset to default.';
    default: {
      const exhaustive: never = preference;
      throw new Error(String(exhaustive));
    }
    }
  case 'available':
    switch (selected) {
    case 'retain-checked': return preference === undefined ? 'Default: retain-checked. BF16 retention is requested on the next image load.' : 'Selected: retain-checked. BF16 retention is requested on the next image load.';
    case 'legacy-expand': return 'Selected: legacy-expand. The existing storage path is requested on the next image load.';
    case undefined: return 'No usable image storage mode could be determined.';
    default: {
      const exhaustive: never = selected;
      throw new Error(String(exhaustive));
    }
    }
  default: {
    const exhaustive: never = capability;
    throw new Error(String(exhaustive));
  }
  }
}
