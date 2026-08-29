export const useChatLifecycle__chat_was_deleted = ({ chatTitle }: {
  readonly chatTitle:
    | { readonly type: 'titled', readonly value: string }
    | { readonly type: 'untitled' },
}): string => {
  switch (chatTitle.type) {
  case 'titled':
    return `聊天“${chatTitle.value}”已删除`;
  case 'untitled':
    return '聊天“未命名”已删除';
  default: {
    const _ex: never = chatTitle;
    return _ex;
  }
  }
};
