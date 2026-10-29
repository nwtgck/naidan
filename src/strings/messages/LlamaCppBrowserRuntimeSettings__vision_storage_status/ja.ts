export function LlamaCppBrowserRuntimeSettings__vision_storage_status({ capability, preference, selected }: { capability: 'available' | 'absent' | 'incompatible' | undefined, preference: 'legacy-expand' | 'retain-checked' | undefined, selected: 'legacy-expand' | 'retain-checked' | undefined }): string {
  switch (capability) {
  case undefined: return 'ランタイムの保持機能を確認中です。';
  case 'incompatible': return 'このランタイムの保持APIには互換性がありません。別の方式へ自動で切り替えません。';
  case 'absent':
    switch (preference) {
    case undefined: return '既定：legacy-expand。このランタイムは保持APIに未対応です。';
    case 'legacy-expand': return '選択：legacy-expand。このランタイムの従来方式を使います。';
    case 'retain-checked': return 'retain-checkedが選択されていますが、このランタイムでは利用できません。従来方式を選ぶか、既定に戻してください。';
    default: {
      const exhaustive: never = preference;
      throw new Error(String(exhaustive));
    }
    }
  case 'available':
    switch (selected) {
    case 'retain-checked': return preference === undefined ? '既定：retain-checked。次の画像読み込みでBF16の保持を要求します。' : '選択：retain-checked。次の画像読み込みでBF16の保持を要求します。';
    case 'legacy-expand': return '選択：legacy-expand。次の画像読み込みで従来方式を使います。';
    case undefined: return '利用できる画像の保持方式を確認できません。';
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
