export const MessageItem__image_missing = ({ fileName, fileSize }: { fileName: string; fileSize: string }): string => (
  `图像缺失（${fileName}）- ${fileSize}`
);
