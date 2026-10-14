import type { AppPermissionsMessages } from '../../../site/messages';

export const strings = {
  title: 'Webアプリとネイティブアプリ、端末のどこまでアクセスできる？',
  description: 'ブラウザ内のページ、デスクトップアプリやCLI、モバイルアプリが端末のどの情報や機能を使え、取得後にどこへ送れるかを比べます。',
  intro: [
    'たとえば文章を書くツールにWeb版とインストール版があるとします。どちらでも作業はできますが、サービスのコードが端末のどの情報や機能にアクセスできるかは変わります。ここでいうWebアプリは、ブラウザ内で動くページ側のコードです。ブラウザ本体のOS権限とは分けて考えます。ネイティブアプリには、端末に導入して動かすデスクトップ・モバイルアプリとコマンドラインツール（CLI）を含めます。',
    'まず、どのファイルや端末の機能を使えるかを比べます。次に、得た情報を送れるかを見ます。Webページも、渡された情報を送ることができます。',
  ],
  noPrompt: {
    title: '許可画面が出なければ、アクセスもできない？',
    body: 'そうとは限りません。Androidでは、アプリを作る人がINTERNET権限を宣言すると、OSがインストール時に自動で付与します。送信のたびに利用者へ確認する仕組みではありません。一方、マイクで録音するアプリはRECORD_AUDIO権限を宣言し、実行時に利用者へ許可を求めます。まだ許可されていなければ、Androidが承認画面を表示します。開発者の宣言、OSの自動付与、利用者の承認は、それぞれ役割が違います。',
    sources: [
      { label: 'Android：INTERNETとRECORD_AUDIOの権限', href: 'https://developer.android.com/reference/android/Manifest.permission' },
      { label: 'Android：権限が付与される仕組み', href: 'https://developer.android.com/guide/topics/permissions/overview' },
    ],
  },
  reach: {
    title: '端末のどの情報や機能にアクセスできる？',
    intro: 'コードが動く場所で、最初の境界が違います。以下は、追加のアクセスを許可する前の、通常のアプリやWebページの例です。',
    cards: [
      {
        title: 'デスクトップアプリ・CLI',
        scope: 'ログイン中の利用者の権限',
        body: '通常のWindowsデスクトッププログラムは、ログイン中の利用者の権限で動くことが多く、その利用者が読めるファイルに、ファイルごとの承認なしでアクセスできます。一時保存先にあるというだけで、ファイルがアプリごとに隔離されるわけではありません。実際に読めるかは各ファイルの保護設定で決まります。実行中のプロセス名も列挙でき、端末で使われているアプリの手がかりになります。OSのファイル保護やアプリのサンドボックスによって範囲は狭まります。',
        sources: [
          { label: 'Microsoft：アクセストークン', href: 'https://learn.microsoft.com/en-us/windows/win32/secauthz/access-tokens' },
          { label: 'Microsoft：プロセスの列挙', href: 'https://learn.microsoft.com/en-us/windows/win32/procthread/process-enumeration' },
          { label: 'Microsoft：プロセス一覧の実行ファイル名', href: 'https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/ns-tlhelp32-processentry32w' },
          { label: 'Microsoft：一時保存先', href: 'https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-gettemppath2a' },
          { label: 'Microsoft：ファイルのアクセス権', href: 'https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights' },
          { label: 'Microsoft：デスクトップアプリの権限', href: 'https://support.microsoft.com/en-us/windows/apps/app-permissions' },
        ],
      },
      {
        title: 'モバイルのネイティブアプリ',
        scope: 'アプリごとのサンドボックス',
        body: 'AndroidとiOSは、ほかのアプリの専用データからアプリを隔離します。ただし、端末の機能すべてに許可画面が出るわけではありません。Androidでは、加速度センサーの生データを専用の実行時承認なしで取得できます。バックグラウンドでの利用や取得頻度には別の制限があります。',
        sources: [
          { label: 'Android：アプリのサンドボックス', href: 'https://source.android.com/docs/security/app-sandbox' },
          { label: 'Apple：iOSのアプリ隔離', href: 'https://support.apple.com/guide/security/sec15bfe098e/web' },
          { label: 'Android：センサーの制限', href: 'https://developer.android.com/develop/sensors-and-location/sensors/sensors_overview' },
          { label: 'Android：高頻度センサーの権限', href: 'https://developer.android.com/reference/android/Manifest.permission#HIGH_SAMPLING_RATE_SENSORS' },
        ],
      },
      {
        title: 'Webアプリのページ',
        scope: 'ブラウザのAPIを通る',
        body: '通常のページには、ホーム内の任意のフォルダやOSのプロセス一覧を直接走査する一般的なAPIはありません。ローカルファイルなら、利用者が選んだファイルをブラウザがページに渡せます。ページが得るのはその範囲で、ブラウザ本体のOS権限すべてではありません。選択方法や継続して使える条件は、ブラウザのAPIによって異なります。',
        sources: [
          { label: 'HTML標準：ファイル選択', href: 'https://html.spec.whatwg.org/multipage/input.html#file-upload-state-(type=file)' },
          { label: 'MDN：File System API', href: 'https://developer.mozilla.org/en-US/docs/Web/API/File_System_API' },
        ],
      },
    ],
    caption: '配布方式やOS側の保護でも範囲は変わります。サンドボックス化されたデスクトップアプリは、通常のデスクトッププロセスより狭い境界で動かせます。',
    sandboxSource: { label: 'Apple：macOSのApp Sandbox', href: 'https://developer.apple.com/documentation/xcode/configuring-the-macos-app-sandbox' },
  },
  send: {
    title: '得た情報は端末の外へ送れる？',
    first: '送れます。ネイティブアプリは、送信のたびに新しい承認を求めずに外向きのインターネット通信を行えます。Webページも、受け取った情報をブラウザの通信APIを通して送れます。端末内の情報や機能にアクセスできるかと、それを外へ送れるかは別の問いです。下の経路は可能性の例で、特定アプリの実際の動作ではありません。',
    second: '使える通信の経路は異なります。通常のWebページは生のTCP/UDPソケットを直接開けず、HTTPやWebSocketなど、ブラウザが提供する方式を使います。別サイトからの返答を読むことには制限がありますが、それは送信全般の禁止ではありません。LANやlocalhostには別の条件があります。サイトはContent Security Policy（CSP）で接続先を絞ることもできますが、その設定はサイトごとです。',
    sources: [
      { label: 'MDN：Fetch API', href: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API' },
      { label: 'MDN：同一オリジンポリシー', href: 'https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy' },
      { label: 'Chrome：通常のWebページと生のソケット', href: 'https://developer.chrome.com/docs/iwa/direct-sockets' },
      { label: 'Apple：ローカルネットワークの条件', href: 'https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy' },
      { label: 'MDN：CSPによる接続先の制限', href: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src' },
    ],
    localOnlyLink: 'Naidanのローカルのみ版での接続先制限を見る',
  },
  choose: {
    title: '同じ作業なら、どちらを選ぶ？',
    body: 'Web版で目的を果たせるなら、ブラウザはページが端末に対して行える操作を仕組みで制限します。通常のページは、ログイン中の利用者やブラウザ本体が扱えるからといって、任意のファイルやOSのプロセス一覧を直接読み取れません。ファイルは利用者が選んだ対象など、ブラウザが提供する経路から受け取ります。この境界が設計どおりに働く限り、こうした直接アクセスはサイトの善意や利用者が毎回気づくことに頼らず防げます。ネイティブアプリが必要な作業もあり、その場合はアプリのサンドボックスと最初から使える権限が判断材料になります。同じ作業をブラウザの境界内で完結できるなら、サービスへ最初から渡す端末のアクセス範囲を小さくできます。',
    note: 'ここで比べたのは「できること」です。特定のアプリが実際に情報を収集・送信した証拠ではありません。',
    sources: [
      { label: 'Chromium：ブラウザのサンドボックスとサイト分離', href: 'https://www.chromium.org/Home/chromium-security/site-isolation/' },
    ],
  },
  visual: {
    desktop: { eyebrow: '通常のWindowsデスクトッププログラム', account: 'ログイン中の利用者', program: 'デスクトップアプリ・CLI', file: 'この利用者が読めるファイル', fileName: 'draft.txt', sample: '下書きの文', outcome: 'ファイルの内容がアプリへ入る', limit: 'ファイル保護やサンドボックスの制限は残る', caption: '通常のWindowsプログラムが、利用者に読めるdraft.txtの内容を読み取る例です。' },
    mobile: { eyebrow: 'Androidアプリの例', app: 'このアプリ', privateData: '別アプリの専用データ', blocked: 'サンドボックスで止まる', blockedToken: '専用データ', sensor: '加速度センサーの生データ', sensorValue: 'x: 0.2', available: '専用の実行時承認画面なし', caption: '別アプリの専用データは隔離されます。一方、加速度の値は専用の承認画面なしでこのアプリに届きます。' },
    web: { eyebrow: '通常のWebページの例', file: '利用者が選んだファイル', fileName: 'draft.txt', browser: 'ブラウザのファイル選択', page: 'Webページ', received: 'draft.txtを受け取る', outside: '未選択のファイルやOSのプロセス一覧は直接渡らない', caption: 'ブラウザが選択されたdraft.txtをページへ渡します。選んでいないファイルは、この経路では渡りません。' },
    send: { desktop: '例：読めるファイル', desktopApp: 'デスクトッププログラム', mobile: '加速度の値', mobileApp: 'Androidアプリ', web: '選んだファイル', webApp: 'WebページとブラウザのHTTP', service: '例：サービス', caption: '上の例で得た情報が、それぞれのアプリからサービスへ進む経路です。送れる可能性を示しています。' },
    noPrompt: { eyebrow: 'Androidでの二つの権限経路', internet: 'インターネット通信', microphone: 'マイクの録音', declaration: 'アプリを作る人が権限を宣言', automatic: 'OSが自動で許可', request: '未許可なら利用者に確認', connected: '通信できる', approved: '承認後に録音できる', noDialog: '実行時の承認画面なし', dialog: '実行時の承認画面あり', caption: 'どちらもアプリを作る人が権限を宣言しますが、マイクの録音には実行時の利用者承認が必要です。' },
  },
  related: {
    boundary: { title: 'Naidanのブラウザ境界を見る', description: 'ページからファイル、クリップボード、ローカルサービスへの経路をたどります。' },
    localOnly: { title: 'Naidanの外部接続先を絞る', description: 'ローカルのみ版に固有の通信ポリシーを確認します。' },
    standalone: { title: 'ブラウザでAIを起動する', description: 'インストーラーや配信用サーバーなしでNaidanのスタンドアロン版を開きます。' },
  },
} satisfies AppPermissionsMessages;
