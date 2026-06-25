export const useChatLifecycle__chat_was_deleted = ({ chatTitle }: { chatTitle: string | undefined }): string => (
  `「${chatTitle ?? '無題'}」を削除しました`
);
