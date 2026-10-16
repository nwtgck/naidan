import type { DocsLocale } from '../../../navigation/routes';
import type { AppDestination } from '../../../navigation/app-entry';
import AppEntryLink from '../../../components/AppEntryLink.vue';
import UiLabel from '../../../components/UiLabel.vue';
import DocsLink from '../../../components/DocsLink.vue';

export const messages = {
  title: "AIとの会話を自由に分岐・編集する",
  description: "元の会話を残しながら、前のメッセージの編集、別の回答、別のチャットへの分岐を試せます。",
  choose_a_conversation_path: "元の会話を残しながら、どの地点からどのように続きを作るかを選べます。",
  open_naidan_to_branch: ({ locale, destination }: { locale: DocsLocale; destination: AppDestination }) => <>まず <AppEntryLink locale={locale} destination={destination} display="path" /> を開きます。初回設定が表示されたら、接続先とモデルを選んで設定を完了してから送信や再生成を行います。メッセージのあるチャットを開くか、新しいチャットで何度かやり取りしてから分岐します。</>,
  in_browser_model_setup_guide: ({ locale }: { locale: DocsLocale }) => <>ブラウザ内モデルを使う場合は、<DocsLink locale={locale} page="in-browser-models">ブラウザ内でAIモデルを動かす手順</DocsLink>をご覧ください。</>,
  create_and_switch_conversation_paths: "会話の続きを作って切り替える",
  edit_resend_or_regenerate: () => <>メッセージの下で、鉛筆なら編集、送信アイコンなら再送信、円形の矢印なら回答を再生成できます。編集後は<UiLabel text="送信して分岐" />を選びます。</>,
  switch_message_versions: "バージョン番号の左右の矢印で続きを切り替えます。編集・再送信では自分のメッセージの下、再生成では回答の下に表示されます。",
  fork_into_a_separate_chat: () => <>別のチャットを作るには、メッセージの下の<UiLabel text="その他の操作" />から<UiLabel text="チャットを分岐" />を選びます。そのメッセージまでの現在の経路が開きます。ヘッダーの分岐ボタンは最後のメッセージまでを含めます。</>,
  try_each_way_to_branch: "分岐の方法をそれぞれ試す",
  keep_versions_or_fork_chat: "同じチャットで比較するか、別のチャットで続きを進めるか",
  how_versions_and_forks_differ: () => <>編集・再送信・再生成では、別の続きも同じチャットに残ります。アシスタントの回答を編集する<UiLabel text="更新して分岐" />は、回答を生成せず、書き換えた内容を保存します。<UiLabel text="チャットを分岐" />は同じチャットグループに「ブラウザ内モデル のフォーク」などの新しいチャットを作って開きます。</>,
  rewrite_a_conversation_path: "会話の履歴をまとめて編集する",
  edit_and_reorder_a_path: "選択中の会話経路をまとめて編集し、元の履歴を残したまま新しい分岐にします。",
} satisfies typeof import('./en').messages;
