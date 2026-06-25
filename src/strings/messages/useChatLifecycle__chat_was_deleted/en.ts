export const useChatLifecycle__chat_was_deleted = ({ chatTitle }: { chatTitle: string | undefined }): string => (
  `Chat "${chatTitle ?? 'Untitled'}" deleted`
);
