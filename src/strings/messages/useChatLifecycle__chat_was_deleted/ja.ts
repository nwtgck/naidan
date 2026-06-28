export const useChatLifecycle__chat_was_deleted = ({ chatTitle }: {
  readonly chatTitle:
    | { readonly type: 'titled', readonly value: string }
    | { readonly type: 'untitled' },
}): string => {
  switch (chatTitle.type) {
  case 'titled':
    return `「${chatTitle.value}」を削除しました`;
  case 'untitled':
    return '「無題」を削除しました';
  default: {
    const _ex: never = chatTitle;
    return _ex;
  }
  }
};
