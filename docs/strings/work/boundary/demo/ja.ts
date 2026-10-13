import type { BoundaryComparisonText } from './en';

export const boundaryComparisonJa = {
  os: 'このPCのOS',
  browser: 'ブラウザ',
  naidanRuntime: 'ブラウザの中で動く',
  directOperation: 'OSを直接操作しようとする',
  blocked: '直接操作を防止',
  api: 'ブラウザのAPIと許可',
  allowed: '許可された経路を通して使う',
  files: '選んだファイルやフォルダ',
  fileAccess: '許可された範囲で読み書きする。',
  clipboard: 'クリップボード',
  clipboardAccess: 'ブラウザの許可や操作のルールに従う。',
  localServer: 'ローカルサーバー',
  localhostAccess: '許可されたHTTP APIで接続する。',
  serverNote: 'localhostのサーバーは、別のプロセスとして、それ自身のOSの権限で動きます。',
  note: 'OSの権限も適用されます。ファイル・クリップボード・通信には、ブラウザとサイトのルールも加わります。',
} satisfies BoundaryComparisonText;
