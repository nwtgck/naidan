export const ImageHostModelDirectories__folder_access = ({ access }: { access: 'readwrite' | 'read' | 'prompt' | 'missing' | 'error' | 'unsupported' }): string => ({
  readwrite: '読み取り・書き込み可能',
  read: '書き込みの許可が必要',
  prompt: 'アクセスの許可が必要',
  missing: 'フォルダの再指定が必要',
  error: 'フォルダにアクセスできません',
  unsupported: 'このブラウザまたはビルドでは利用できません',
})[access];
