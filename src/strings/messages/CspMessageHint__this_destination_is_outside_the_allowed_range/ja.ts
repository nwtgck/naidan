export const CspMessageHint__this_destination_is_outside_the_allowed_range = ({ url }: { url: string | undefined }): string => (
  `この接続先${url === undefined ? '' : `（${url}）`}は、この許可範囲に含まれていません。`
);
