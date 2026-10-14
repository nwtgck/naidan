import type { HostedGuideMessages } from '../../../site/messages';

export const strings = {
  title: 'Hosted版ZIPを自分のHTTPサーバーで使う',
  description: 'NaidanのHosted版ZIPを取得し、展開したファイルをPythonなどの静的HTTPサーバーで配信して、モデルを選ぶまでを案内します。',
  intro: 'Hosted版ZIPを使うと、Naidanの画面を自分のHTTPサーバーから配信できます。まずはこの端末でPythonを使って開き、必要なら同じファイルを好みの静的サーバーで配信します。',
  releaseLink: '最新のリリースを開く',
  stepsTitle: '展開したZIPからNaidanを開く',
  download: {
    title: 'Hosted版ZIPを取得して展開する',
    before: 'リリースページでHosted版のファイルを選びます。例えばv0.24.1のリリースなら',
    after: 'です。スタンドアロン版のZIPと取り違えず、ZIP全体を展開します。',
    folderBefore: 'この例では、中にあるバージョン付きフォルダは',
    folderAfter: 'です。index.htmlとassetsなどの補助ファイルを一緒に保ちます。',
  },
  serve: {
    title: 'index.htmlがあるフォルダを配信する',
    before: '展開したフォルダのうち、index.htmlがある場所で端末のターミナルを開き、次を実行します。',
    after: 'Naidanを使う間はターミナルを開いたままにします。配信を終えるときは、そのターミナルでCtrl+Cを押します。',
  },
  open: {
    title: 'ブラウザでローカルのアドレスを開く',
    before: 'ブラウザで',
    after: 'を開きます。Naidanの画面が表示されれば、ファイルを配信できています。',
  },
  otherServer: {
    title: 'ほかの静的サーバーを使う',
    body: 'Nginx、npx serveなどの静的HTTPサーバーでも、index.htmlと補助ファイルを含むディレクトリを希望のURLやパスで公開し、そのURLをブラウザで開きます。親ディレクトリを公開した場合はサブパスでも配信でき、バージョン付きフォルダのパスを開きます。ループバック以外のHTTPアドレスでは、安全なコンテキストを要するブラウザ機能が使えない場合があります。必要な機能があるときはHTTPSを使ってください。',
  },
  model: {
    title: '画面が開いたらモデルを選ぶ',
    body: '静的サーバーが返すのはアプリのファイルです。推論は実行しません。応答を得るには、対応するブラウザ内モデルを準備するか、別に動いているOllamaなどのエンジンへ接続します。Naidanでモデルを選び、短いメッセージを送って確認してください。',
    nextBefore: '次の手順は',
    browserGuide: 'ブラウザ内モデルのガイド',
    nextMiddle: '、',
    ggufGuide: 'GGUFの設定ガイド',
    nextOr: '、または',
    engineGuide: 'ローカルエンジンのガイド',
    nextAfter: 'を参照してください。',
  },
  flow: {
    zip: '展開したHosted版ZIP',
    server: '静的HTTPサーバー',
    browser: 'ブラウザ内のNaidan',
    model: 'モデル・推論エンジン',
    caption: 'HTTPサーバーは画面のファイルを配信します。Naidanはブラウザで動き、応答はブラウザ内モデルまたは別の推論エンジンが生成します。',
  },
  origin: {
    title: 'Hosted版ZIPを選ぶ理由',
    body: 'HTTPのURLで開くと、ページには通常のWebオリジンが付きます。file://で直接開いたページのOriginはnullとなり、推論サーバーのCORS設定によって拒否される場合があります。HTTPオリジンがあっても、すべての接続が自動で許可されるわけではありません。ブラウザと接続先の通信条件を確認します。',
  },
  update: {
    title: '同じアドレスでファイルを更新する',
    files: '新しいHosted版ZIPを別フォルダに展開します。PythonのサーバーをCtrl+Cで止め、新しいindex.htmlがあるフォルダから同じアドレスとポートで起動し、同じURLを開き直します。ほかの静的サーバーでも、公開ファイルを切り替え、アプリのURLとベースパスを保ちます。',
    storage: 'ブラウザ内の保存データは展開先フォルダではなく、サイトのオリジン（スキーム・ホスト名・ポート）に結び付きます。保存した会話を継続するには同じオリジンを使います。ただし［一時保存］の会話や設定は再読み込みで失われます。オリジンを変える場合は必要な会話データを先にバックアップします。そのZIPにダウンロード済みのモデル本体やキャッシュは含まれません。',
    pwaBefore: 'Naidanに更新の案内が表示されたら、その案内に従ってください。PWAの準備とオフラインでの確認は、',
    pwaGuide: 'NaidanをPWAとしてオフラインで使う',
    pwaAfter: 'を参照してください。ガイドは公開Hosted版のアドレスを例にしています。自己配信版で試すときは、配信した同じURLとブラウザで確認します。ZIPが手元にあるだけでは、オフライン動作を確認できません。',
  },
  related: {
    offline: 'NaidanをPWAとしてオフラインで使う',
    offlineDescription: 'Hosted版とローカルモデルを準備し、切断後に両方の動作を確認します。',
    standalone: 'スタンドアロン版ZIPを直接開く',
    standaloneDescription: '画面配信用のHTTPサーバーを使わず、別のfile://版を開きます。',
    backup: '会話をZIPでバックアップする',
    backupDescription: 'ブラウザやサイトのオリジンを変える前に会話データを書き出します。',
  },
} satisfies HostedGuideMessages;
