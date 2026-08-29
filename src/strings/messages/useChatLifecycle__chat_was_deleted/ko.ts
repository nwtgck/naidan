export const useChatLifecycle__chat_was_deleted = ({ chatTitle }: {
  readonly chatTitle:
    | { readonly type: 'titled', readonly value: string }
    | { readonly type: 'untitled' },
}): string => {
  switch (chatTitle.type) {
  case 'titled':
    return `채팅 "${chatTitle.value}" 삭제됨`;
  case 'untitled':
    return '채팅 "제목 없음" 삭제됨';
  default: {
    const _ex: never = chatTitle;
    return _ex;
  }
  }
};
