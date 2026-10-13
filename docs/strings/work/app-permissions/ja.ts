import type { AppPermissionsMessages } from '../../../site/messages';

export const strings = {
  title: 'Webアプリとネイティブアプリ、端末のどこまでアクセスできる？',
  description: 'ブラウザ内のページ、デスクトップアプリやCLI、モバイルアプリが、個別の承認前に端末の何へアクセスでき、取得後にどこへ送れるかを比べます。',
  intro: [
    'たとえば文章を書くツールにWeb版とインストール版があるとします。どちらでも作業はできますが、サービスのコードが端末のどこまで届くかは変わります。ここでいうWebアプリは、ブラウザ内で動くページ側のコードです。ブラウザ本体のOS権限とは分けて考えます。ネイティブアプリには、端末に導入して動かすデスクトップ・モバイルアプリとコマンドラインツール（CLI）を含めます。',
    '選ぶ前に、二つの問いを見ます。端末内の何を読んだり観測したりできるか。得た情報をどこへ送れるか。',
  ],
  noPrompt: {
    title: '許可画面が出なければ、アクセスもできない？',
    body: 'そうとは限りません。Androidのアプリは、開発者がマニフェストにINTERNETを宣言すると、インストール時にこの「normal」権限を自動付与されます。通信のたびに利用者が許可する仕組みではありません。開発者の宣言、OSによる自動付与、利用者の承認、使用中の通知は別のものです。',
    sources: [
      { label: 'Android：INTERNET権限', href: 'https://developer.android.com/reference/android/Manifest.permission#INTERNET' },
      { label: 'Android：権限が付与される仕組み', href: 'https://developer.android.com/guide/topics/permissions/overview' },
    ],
  },
  reach: {
    title: '端末内の何に届く？',
    intro: 'コードが動く場所で、最初の境界が違います。以下は、追加のアクセスを許可する前の、通常のアプリやWebページの目安です。',
    cards: [
      {
        title: 'デスクトップアプリ・CLI',
        scope: 'ログイン中の利用者の権限',
        body: '通常のデスクトッププログラムは、ログイン中の利用者の権限で動くことが多くあります。Windowsでは、その利用者が読めるファイルを読んだり、実行中のプロセスを列挙したりできます。対象ごとに別の承認を求める方式ではありません。サンドボックス化されていないmacOSアプリも、自分の保存領域の外にあるファイルへアクセスできます。ファイルの保護やアプリのサンドボックスによって範囲は狭まります。',
        sources: [
          { label: 'Microsoft：アクセストークン', href: 'https://learn.microsoft.com/en-us/windows/win32/secauthz/access-tokens' },
          { label: 'Microsoft：プロセスの列挙', href: 'https://learn.microsoft.com/en-us/windows/win32/procthread/process-enumeration' },
          { label: 'Microsoft：デスクトップアプリの権限', href: 'https://support.microsoft.com/en-us/windows/apps/app-permissions' },
          { label: 'Apple：アプリの保存領域外のファイル', href: 'https://developer.apple.com/documentation/foundation/using-the-file-system-effectively' },
        ],
      },
      {
        title: 'モバイルのネイティブアプリ',
        scope: 'アプリごとのサンドボックス',
        body: 'AndroidとiOSは、ほかのアプリの専用データからアプリを隔離します。ただし端末の機能すべてに承認画面が出るわけではありません。たとえばAndroidの加速度・ジャイロの生データは、専用の実行時承認なしで取得できます。バックグラウンドでの利用や取得頻度には別の制限があります。',
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
        body: '通常のページには、ホーム内の任意のフォルダやOSのプロセス一覧を直接走査する一般的なAPIはありません。ローカルファイルなら、利用者が選んだファイルやフォルダへのアクセスをブラウザがページに渡せます。ページが得るのはその範囲であり、ブラウザ本体のOS権限すべてではありません。',
        sources: [
          { label: 'MDN：File System API', href: 'https://developer.mozilla.org/en-US/docs/Web/API/File_System_API' },
        ],
      },
    ],
    caption: '配布方式やOS側の保護でも範囲は変わります。サンドボックス化されたデスクトップアプリは、通常のデスクトッププロセスより狭い境界で動かせます。',
    sandboxSource: { label: 'Apple：macOSのApp Sandbox', href: 'https://developer.apple.com/documentation/xcode/configuring-the-macos-app-sandbox' },
  },
  send: {
    title: '得た情報は端末の外へ送れる？',
    first: 'どちらも送れます。ネイティブアプリは、送信のたびに新しい承認を求めずに外向きのインターネット通信を行えます。Webページも、受け取った情報を自分のサービスや、ブラウザが許すほかの接続先へ送れます。別サイトからの返答を読むことには制限がありますが、それは情報を送ること全般の禁止ではありません。',
    second: '使える通信の経路は異なります。通常のネイティブアプリはTCPやUDPのソケットを直接使えます。通常のWebページは生のTCP/UDPソケットを直接開けず、HTTPやWebSocketなど、ブラウザが提供する方式を使います。LANやlocalhostにはそれぞれ別のルールがあります。サイトはContent Security Policy（CSP）で接続先を絞ることもできますが、その設定はサイトごとです。',
    sources: [
      { label: 'MDN：同一オリジンポリシー', href: 'https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy' },
      { label: 'Chrome：通常のWebページと生のソケット', href: 'https://developer.chrome.com/docs/iwa/direct-sockets' },
      { label: 'Apple：ローカルネットワークの条件', href: 'https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy' },
      { label: 'MDN：CSPによる接続先の制限', href: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src' },
    ],
    localOnlyLink: 'Naidanのローカルのみ版での接続先制限を見る',
  },
  choose: {
    title: '同じ作業なら、どちらを選ぶ？',
    body: 'Web版で目的を果たせるなら、ページのコードはブラウザが仲介する範囲で動かせます。一方、入力した情報、選んだファイル、許可したデータをサイトへ託すことは変わりませんし、ページはそれを送信できます。ネイティブアプリが必要なら、実際のサンドボックスと自動付与される能力を確認します。モバイルアプリと通常のデスクトッププログラムでは、最初の境界も違います。',
    note: 'ここで比べたのは「できること」です。特定のアプリが実際に情報を収集・送信した証拠ではありません。',
  },
  related: {
    boundary: { title: 'Naidanのブラウザ境界を見る', description: 'ページからファイル、クリップボード、ローカルサービスへの経路をたどります。' },
    localOnly: { title: 'Naidanの外部接続先を絞る', description: 'ローカルのみ版に固有の通信ポリシーを確認します。' },
    standalone: { title: 'ブラウザでAIを起動する', description: 'インストーラーや配信用サーバーなしでNaidanのスタンドアロン版を開きます。' },
  },
} satisfies AppPermissionsMessages;
