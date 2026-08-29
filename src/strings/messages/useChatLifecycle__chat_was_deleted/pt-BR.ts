export const useChatLifecycle__chat_was_deleted = ({ chatTitle }: {
  readonly chatTitle:
    | { readonly type: 'titled', readonly value: string }
    | { readonly type: 'untitled' },
}): string => {
  switch (chatTitle.type) {
  case 'titled':
    return `Chat "${chatTitle.value}" excluído`;
  case 'untitled':
    return 'Chat "Sem título" excluído';
  default: {
    const _ex: never = chatTitle;
    return _ex;
  }
  }
};
