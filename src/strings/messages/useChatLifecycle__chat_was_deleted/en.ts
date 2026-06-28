export const useChatLifecycle__chat_was_deleted = ({ chatTitle }: {
  readonly chatTitle:
    | { readonly type: 'titled', readonly value: string }
    | { readonly type: 'untitled' },
}): string => {
  switch (chatTitle.type) {
  case 'titled':
    return `Chat "${chatTitle.value}" deleted`;
  case 'untitled':
    return 'Chat "Untitled" deleted';
  default: {
    const _ex: never = chatTitle;
    return _ex;
  }
  }
};
