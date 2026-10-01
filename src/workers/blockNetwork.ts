/** Worker の中で塞ぐ通信の API。 */
export const NETWORK_APIS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'] as const;

/**
 * 通信の API を使えなくする。塞げなかった名前を返す。
 *
 * 同一オリジンのスクリプトから作った Worker には、ページの `<meta>` の CSP が引き継がれない
 * （Worker は自分のスクリプトの応答ヘッダの CSP に従う）。原稿とルールは変換の Worker へ
 * 渡るので、「入力とルールは外部へ送信しない」約束をその中でも守るよう、最初に塞ぐ。
 * Worker のコードは通信しないが、塞いでおけば将来の変更で黙って破れない。
 */
export function blockNetworkApis(scope: object): string[] {
  const failed: string[] = [];
  for (const name of NETWORK_APIS) {
    try {
      Object.defineProperty(scope, name, {
        value: undefined,
        writable: false,
        configurable: false,
      });
    } catch {
      failed.push(name);
    }
  }
  return failed;
}
