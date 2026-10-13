import type { LocalEnginesMessages } from '../../../site/messages';

export const strings = {
  title: 'NaidanからOllamaやllama.cppのサーバーに接続する',
  description: '手元の端末で動くOllamaやllama.cppのサーバーをNaidanで使う手順です。APIプロバイダーとURLを選び、接続を確認してモデルを指定します。',
  intro: [
    'ローカルの推論エンジンを使うと、Naidanで会話しながら、モデルの実行はブラウザの外で行えます。先にエンジンを起動し、そこでモデルを利用できるようにします。NaidanはHTTP APIを通じて接続します。エンジンは独立したプロセスで、独自の権限を持ちます。',
    'Naidanにはローカル用のURLプリセットがあります。エンジンのAPIに合うものを選び、モデルを指定する前に接続を確認します。プリセットは接続先の候補であり、Naidanがサーバーを起動するわけではありません。',
  ],
  flow: {
    browser: 'ブラウザ内のNaidan',
    connection: 'ローカルAPIへのHTTP通信',
    engine: 'エンジンのプロセスとモデル',
    caption: 'Naidanが選んだアドレスのエンジンへチャットのリクエストを送り、そのプロセスで生成した応答をブラウザに返す流れです。',
  },
  enginesTitle: 'エンジンに合うAPIプロバイダーを選ぶ',
  openGuide: '設定手順を見る',
  engines: [
    {
      title: 'Ollama',
      guide: 'models/ollama',
      provider: 'API プロバイダー：Ollama',
      preset: 'Ollama (local) · http://localhost:11434',
      body: 'Ollamaのサービスが通常のローカルアドレスで待ち受けている場合は、このプリセットを選びます。NaidanはOllama APIを使い、サービスから取得したモデル一覧を表示します。',
    },
    {
      title: 'llama.cppのサーバー',
      guide: 'models/openai-compatible',
      provider: 'API プロバイダー：OpenAI 互換',
      preset: 'llama-server (local) · http://localhost:8080/v1',
      body: 'llama-serverのプリセットはOpenAI互換APIを使うため、URL末尾の /v1 も含めます。このサーバーはブラウザ内で動くllama.cppとは別です。同じAPIプロバイダーには、http://localhost:1234/v1 を使うLM Studioのプリセットもあります。',
    },
  ],
  stepsTitle: '初回設定で接続する',
  steps: [
    {
      title: 'エンジンとモデルを準備する',
      body: 'エンジン自身の案内に従ってHTTPサービスを起動し、少なくとも1つのモデルを利用できる状態にします。待ち受けアドレスを確認してください。ポートやベースパスを変えた場合は、プリセットではなく実際のURLをNaidanに入力します。',
    },
    {
      title: '対応するプロバイダーとURLを選ぶ',
      body: 'Naidanの初回設定で［Ollama］または［OpenAI 互換］を選び、対応するローカルプリセットを選択します。既存サーバーのURLを直接入力することもできます。接続先が要求する場合だけ［カスタム HTTP ヘッダー］を追加します。',
    },
    {
      title: '接続を確認して始める',
      body: '［接続を確認］を押します。接続に成功したら、サーバーが返した一覧から［デフォルトモデル］を選び、［始める］を押します。モデルが表示されない場合は、エンジン側でモデルを利用できるか確認してからやり直します。',
    },
  ],
  laterTitle: '後から接続先を変える',
  later: '［設定］→［接続］を開きます。［エンドポイント設定］で［API プロバイダー］と［エンドポイント URL］を指定し、［接続を確認］を押します。［モデル選択］で［デフォルトモデル］を選び、［変更を保存］します。保存した値は、グローバルの接続先またはモデルを継承する既存・新規の会話にも使われます。別の設定が使われる場合は、チャットやグループの上書きを確認してください。',
  troubleTitle: '接続を確認できないとき',
  trouble: [
    {
      title: 'アドレスやAPIが合っていない',
      body: 'エンジンが起動しているか、ポートが待ち受け先と一致しているかを確認します。Ollamaには［Ollama］、llama-serverには［OpenAI 互換］を選び、llama-serverのプリセットでは /v1 を残します。ベースURLに応答しても、Naidanが必要なモデル一覧APIに対応していない場合があります。',
    },
    {
      title: 'ブラウザが通信を止めている',
      body: 'ブラウザにはオリジン、CORS、混在コンテンツの制約があり、Hosted版の一部にはCSPの制約もあります。スタンドアロン版は file:// から開くため、リクエストの Origin が null になり、エンジン側で許可が必要な場合があります。ブラウザのエラーを確認し、自分の接続先で許可するオリジンを設定してから再試行します。',
    },
    {
      title: 'モデル一覧が空になっている',
      body: 'エンジンにモデルがあり、APIが一覧を返すか確認します。［接続］の設定画面で自動的に接続を確認するのはlocalhostのURLだけです。それ以外のアドレスでは［接続を確認］を手動で押します。接続先を変えた後は、新しいサーバーのモデル一覧を取得し直して選びます。',
    },
  ],
  boundary: 'ローカルURLを選ぶと、チャットのリクエストはそのエンジンのプロセスに送られます。別の端末や外部のエンドポイントを選ぶ場合、入力した内容と送信対象の会話履歴はそのアドレスへ渡ります。モデルの動作、ファイルへのアクセス、外部通信はエンジンとその設定によって決まります。',
  next: 'ブラウザ内でAIモデルを動かす',
  nextDescription: '別の推論サーバーを使わずに動かせるブラウザ内モデル方式を比べます。',
} satisfies LocalEnginesMessages;
