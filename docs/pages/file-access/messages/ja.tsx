import type { DocsLocale, DocsPageId } from '../../../navigation/routes';
import type { AppDestination } from '../../../navigation/app-entry';
import DocsLink from '../../../components/DocsLink.vue';
import AppEntryLink from '../../../components/AppEntryLink.vue';
import UiLabel from '../../../components/UiLabel.vue';

export const messages = {
  launch_app_and_model_guide: ({ locale, destination, page }: { locale: DocsLocale; destination: AppDestination; page: DocsPageId }) => <>{"まず "}<AppEntryLink locale={locale} destination={destination} display="path" />{" を開き、ファイルやフォルダを使うチャットを選ぶか作成します。初回設定は × で閉じても添付できます。マウントしたファイルやフォルダをAIに調べてもらう前に、利用可能な接続先とツール呼び出しに対応するモデルを設定してください。"}{"ブラウザ内モデルを使う場合は、"}<DocsLink locale={locale} page={page}>{"ブラウザ内でAIモデルを動かす手順"}</DocsLink>{"をご覧ください。"}</>,
  read_saved_files_with_shell: ({ locale, page }: { locale: DocsLocale; page: DocsPageId }) => <>{"Naidan内のファイルを読むマウントがオンなら、シェルは別チャット由来の保存済みファイルも読めます。詳しくは"}<DocsLink locale={locale} page={page}>{"会話と保存済みファイルをシェルで読む設定"}</DocsLink>{"をご覧ください。"}</>,
  on_your_device: "手元の端末",
  other_folders: "ほかのフォルダ",
  folder_copy: "フォルダ（コピー）",
  mounted_folder: "マウントしたフォルダ",
  read_only: "読み取り専用",
  copy_label: "コピー",
  reading_allowed_writing_disabled: "読み取り可能・書き込み無効",
  title: "AIが読み書きできるファイルとフォルダを選ぶ",
  description: "NaidanでAIに渡す単体ファイルやフォルダを選びます。コピーとリンク、読み取りと書き込みの違い、変更が反映される場所を確認できます。",
  intro: () => ["AIに渡すのは、作業に必要なファイルだけに絞れます。単体ファイル、フォルダの独立したコピー、元のフォルダへのリンクから選び、書き込みの範囲も指定できます。"],
  folder_copy_caption: () => <><UiLabel text="フォルダ（コピー）" />で取り込んだフォルダを、読み取り専用で公開する例です。PCにある元のフォルダと、ブラウザ内の作業用コピーを分けて扱います。</>,
  copy_folder_method_title: () => <>フォルダをコピーして、別の場所で試す</>,
  copy_folder_method_body: "選んだフォルダをブラウザの保存領域に取り込みます。編集はそのコピーに反映され、元のフォルダはそのままです。確認した結果をダウンロードして持ち出せます。取り込み後の元フォルダとコピーの変更は、それぞれ独立しています。",
  link_folder_method_title: () => <>フォルダをリンクして、元のファイルを扱う</>,
  link_folder_method_body: "対応するブラウザで実際のフォルダを選びます。その時点の内容を読み取ることができ、ブラウザの書き込み許可と書き込み可能なマウント設定がそろうと、変更は元のファイルに反映されます。直接編集したいときの選択肢です。",
  read_and_write_permissions_title: "読む許可と、編集する許可を分ける",
  read_and_write_permissions_body: "参考資料を読ませたり構成を調べたりするなら、読み取り専用で使えます。編集を任せたいファイルやフォルダのマウントだけを書き込み可能にします。フォルダの選択、ブラウザの許可、そのチャットのマウント設定がPC上のフォルダへのアクセス範囲を決めます。",
  choose_file_title: "対象のファイルやフォルダ",
  choose_file_body: "関係のないファイルを含む大きなディレクトリより、単体ファイルや作業するプロジェクトのサブフォルダを選びます。",
  choose_scope_title: "公開する範囲",
  choose_scope_body: "全体設定、チャットグループ、チャットの設定から、その会話のマウントが決まります。このチャットでどのファイルやフォルダが見えるかを確認します。",
  check_destination_title: "変更が反映される場所",
  check_destination_body: "リンク先なら元のファイル、コピーならブラウザ内のデータが編集対象です。作業を頼む前に、この違いを確認します。",
  add_file_or_folder_title: "ファイルや作業用フォルダを追加する",
  add_file_or_folder_steps: () => ["チャット入力欄の添付メニューを開きます。", <>{"単体の非画像ファイルなら"}<UiLabel text="ファイル" />{"を選んで指定します。ブラウザの保存領域にコピーされ、読み取り専用でマウントされて、このチャットの"}<UiLabel text="シェル" />{"が有効になります。次のフォルダ選択は飛ばします。"}<UiLabel text="ファイル" />{"で画像だけを選んだ場合はメッセージへの添付になります。AIに添付画像の内容を読ませるには、メッセージを送信する前に、利用可能な接続先と画像入力に対応するモデルを設定します。"}</>, <>{"フォルダなら"}<UiLabel text="フォルダ（コピー）" />{"または"}<UiLabel text="フォルダ（リンク）" />{"を選び、対象を指定します。選べる方法はブラウザの対応状況によって変わります。手順2で非画像ファイルを選んだ場合は、手順4へ進みます。"}</>, <>{"チャット入力欄の上に表示されるマウント先のパスと読み取り専用の設定を確認します。ファイルやフォルダをマウントすると、このチャットの"}<UiLabel text="シェル" />{"が有効になり、ツール呼び出しに対応するモデルなら内容を調べられます。シェルで読み出した結果は選んだモデルの入力となり、サーバーモデルなら設定した接続先へ送られます。メッセージに添付した画像は、このマウント手順の対象外です。"}</>, "最初は内容の数行を読む、ファイル名を一覧にするなど、小さな確認を頼み、結果を確かめます。その後で編集を頼む場合は、チャット入力欄の上に表示されたマウント先の鍵ボタンで書き込みを許可します。リンクしたフォルダにはブラウザの書き込み許可も必要です。"],
  browser_permissions_guide_title: "ブラウザ内AIの処理とアクセス権限を確認する",
  browser_permissions_guide_description: "許可したファイルがローカルAIに届く流れと、ブラウザの権限の範囲を確認します。",
  file_explorer_guide_title: "ファイルエクスプローラーでファイルを扱う",
  file_explorer_guide_description: "保存済みファイルを自分で確認し、追加・ダウンロード・整理する手順です。",
  file_settings_guide_title: "設定でファイルとフォルダを管理する",
  file_settings_guide_description: "保存済みファイルとチャットで使う作業用フォルダの設定を確認します。",
} satisfies typeof import('./en').messages;
