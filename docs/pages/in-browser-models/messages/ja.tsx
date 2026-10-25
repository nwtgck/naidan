import AppEntryLink from '../../../components/AppEntryLink.vue';
import type { AppDestination } from '../../../navigation/app-entry';
import type { DocsLocale } from '../../../navigation/routes';
import UiLabel from '../../../components/UiLabel.vue';

export const messages = {
  title: 'ブラウザ内でAIモデルを動かす',
  description: 'ローカルLLMを端末内で動かしてチャットを始めます。llama.cpp、Transformers.js、ブラウザ提供モデルの違いと、スタンドアロン版で使える選択肢を確認できます。',
  intro: () => ['ローカルLLMをブラウザで試すなら、llama.cppでGGUFモデルを動かす方法から始められます。モデルが端末内で回答し、プロンプトを推論サーバーへ送りません。手元のモデルや、用意されたカタログから選べます。', 'GGUFでの応答生成は、アプリ・実行環境・モデルファイルを手元で利用できる状態ならオフラインでも行えます。モデルファイルを先に取得する際は、配布元へ通信します。対応モデルや速度は、ブラウザと端末の性能によって変わります。'],
  chat_message: 'チャットのメッセージ',
  browser_runtime_and_model: 'ブラウザ内の実行環境とモデル',
  chat_answer: 'チャットに届く応答',
  browser_model_flow_caption: 'この方法では、選んだモデルがブラウザ内で応答を生成します。モデルファイルを準備するときには、別途ダウンロードが必要な場合があります。',
  browser_runtime_choices_heading: '使い方に合うブラウザ内モデルを選ぶ',
  view_setup_guide: '設定手順を見る',
  llama_cpp_heading: 'ブラウザ内のllama.cpp',
  llama_cpp_availability: 'Hosted版・スタンドアロン版で利用可能',
  llama_cpp_description: () => <>候補のGGUFを選ぶ、Hugging Faceで検索する、手元のファイルを使う、という方法があります。ブラウザ内へのコピー保存、対応する端末フォルダのリンク、コピーを保存しない一時利用から選べます。</>,
  transformers_js_heading: 'Transformers.js',
  transformers_js_availability: 'Hosted版のみ・試験的な機能',
  transformers_js_description: () => <>Transformers.jsのモデル管理画面で対応するONNXモデルをダウンロードすると、完了後にそのモデルの読み込みが自動で始まります。取得済みのモデルには<UiLabel text="読み込む" />、未完了のモデルには<UiLabel text="再開" />が表示されます。モデルファイルはブラウザのOPFSに保存されます。スタンドアロン版では、ローカルファイルから開いたときのWorkerとWebAssemblyの制約により利用できません。</>,
  browser_provided_model_heading: 'ブラウザ提供モデル',
  browser_provided_model_availability: 'ブラウザがモデルを提供する場合のみ',
  browser_provided_model_description: () => <><UiLabel text="ブラウザ提供" />を選び、利用状況を確認します。準備が必要なモデルが表示されたら<UiLabel text="ブラウザ提供モデルを準備" />を選びます。モデルはブラウザが管理するため、利用可否やダウンロードの動作もブラウザによって変わります。</>,
  start_gguf_chat_heading: 'GGUFモデルでチャットを始める',
  open_app: ({ locale, destination }: { locale: DocsLocale; destination: AppDestination }) => <><AppEntryLink locale={locale} destination={destination} display="label">Naidanを開く</AppEntryLink>とモデルを選べます。以下はllama.cppの手順です。ONNXやブラウザ提供モデルは、上の個別ガイドをご覧ください。</>,
  select_llama_cpp_heading: 'GGUFモデルを選ぶ',
  select_llama_cpp_instructions: () => <>ホームの紹介からモデルを選ぶか、手元のファイルを使う欄でGGUFやモデルフォルダを選びます。</>,
  prepare_model_files_heading: '内容を確かめて準備する',
  prepare_model_files_instructions: () => <>紹介されたモデルでは、量子化形式と容量を確かめ、<UiLabel text="ブラウザ内で動かす" />を選びます。ホームからは必要なファイルをブラウザ内（OPFS）へ取得し、実行環境を準備します。モデルのリンクでは、開始前にHugging Faceへリポジトリの情報を問い合わせることがありますが、モデル本体の取得には明示的な開始操作が必要です。ローカルのみ版では、別途入手したファイルを使ってください。手元から選んだファイルは一時利用で始まり、後からブラウザ内へ保存できます。</>,
  choose_conversation_model_heading: '準備したモデルでチャットを開く',
  choose_conversation_model_instructions: () => <>準備が終わると、選んだモデルをそのチャットで使える状態になります。始めるためにグローバルのデフォルト設定を保存する必要はありません。入力欄のそばのモデル選択から、そのチャットで使う別の利用可能なモデルも選べます。</>,
  send_first_message_heading: '短いメッセージで試す',
  send_first_message_instructions: () => <>チャットを使える状態になったら、短いテキストを送って試してください。モデルが見つからない場合は、入力欄のそばの<UiLabel text="モデルを選ぶ" />から、ファイルの選択、Hugging Faceでの検索、保存済みモデルの利用へ進めます。下書きは残り、ファイルがないだけでダウンロードが始まることはありません。</>,
  media_input_limits_heading: '画像や音声を扱う前に',
  media_input_limits: () => ['llama.cppのチャットに画像を添付するには、モデルと組み合わせる画像入力用の補助GGUF（mmproj）が必要です。現在のllama.cppのチャット入力は、音声と動画に対応していません。画像や音声の生成には、それぞれ別のモデル機能と設定を使います。', 'スタンドアロン版にもブラウザ内のllama.cppがありますが、組み込みのWebGPU実行環境だけを使い、CPUには切り替わりません。Hosted版にはほかの実行環境もあります。ブラウザと端末で使えるかは、アプリ内の案内を確認してください。Transformers.jsはHosted版だけで使えます。', 'モデルファイルと会話履歴では保存先の管理が異なります。ブラウザのサイトデータを削除すると、保存したモデルも失われることがあります。リンクしたフォルダにはアクセス許可が必要です。一時利用のファイル登録は、このページを再読み込みするか閉じるまでで、チャットにモデル指定が残っていても失われます。'],
  local_server_guide_title: 'NaidanからOllamaやllama.cppのサーバーに接続する',
  local_server_guide_description: '端末で動いている推論サーバーのURLとモデルをNaidanで選びます。',
} satisfies typeof import('./en').messages;
