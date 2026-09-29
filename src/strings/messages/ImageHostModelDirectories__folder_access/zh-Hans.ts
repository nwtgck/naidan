export const ImageHostModelDirectories__folder_access = ({ access }: { access: 'readwrite' | 'read' | 'prompt' | 'missing' | 'error' | 'unsupported' }): string => ({
  readwrite: '可读写',
  read: '需要写入权限',
  prompt: '需要访问权限',
  missing: '请重新选择文件夹',
  error: '无法访问文件夹',
  unsupported: '此浏览器或构建版本不可用',
})[access];
