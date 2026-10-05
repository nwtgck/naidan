export const ImageHostModelDirectories__folder_access = ({ access }: { access: 'readwrite' | 'read' | 'prompt' | 'missing' | 'error' | 'unsupported' }): string => ({
  readwrite: '읽기 및 쓰기 가능',
  read: '쓰기 권한 필요',
  prompt: '권한 필요',
  missing: '폴더를 다시 선택하세요',
  error: '폴더에 접근할 수 없음',
  unsupported: '이 브라우저 또는 빌드에서 사용할 수 없음',
})[access];
