import type { BoundaryComparisonText } from './en';

export const boundaryComparisonJa = {
  os: 'このPCのOS',
  browser: 'ブラウザ',
  naidanRuntime: 'ブラウザの中で動く',
  directOperation: 'OSを直接操作しようとする',
  blocked: '直接操作を防止',
  api: 'ブラウザが仲介するAPI',
  allowed: '届く範囲と条件はAPIごとに異なる',
  files: '選んだファイルやフォルダ',
  fileAccess: '選んだ対象の範囲。書き込みには別の許可。',
  clipboard: 'クリップボード',
  clipboardAccess: '読む／書くで条件が異なり、ブラウザにもよる。',
  localServer: 'ローカルサーバー',
  localhostAccess: 'HTTPで指定した接続先へ。',
  serverNote: 'localhostのサーバーは、別のプロセスとして、それ自身のOSの権限で動きます。',
  note: 'OSの権限も適用されます。ファイル・クリップボード・通信には、ブラウザとサイトのルールも加わります。',
} satisfies BoundaryComparisonText;
