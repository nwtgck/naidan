import type { StorageChoiceDemoCopy } from './en';

export const storageChoiceDemoJa = {
  sectionTitle: '保存先の管理',
  fieldLabel: '現在の保存先',
  options: {
    opfs: {
      title: 'Origin Private File System（OPFS）',
      description: 'ブラウザの大容量ファイルシステムへ保存します。大きなデータと添付ファイルに適しています。',
    },
    local: {
      title: 'Local Storage',
      description: '標準的なブラウザストレージへ保存します。容量は5〜10MB程度に制限され、送信画像は永続化されません。',
    },
    memory: {
      title: '一時保存',
      description: 'メモリ内だけに保存します。ページの再読み込みやタブを閉じるとすべてのデータが失われ、永続データは残りません。',
    },
  },
} satisfies StorageChoiceDemoCopy;
