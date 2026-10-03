import { handleConversionRequest } from '../lib/conversionProtocol';
import { blockNetworkApis } from './blockNetwork';

/**
 * 変換を走らせる Web Worker（issue #31）。中身は `handleConversionRequest` だけ。
 * 原稿とルールを受け取るので、何より先に通信の API を塞ぐ（`blockNetworkApis`）。
 */
const unblocked = blockNetworkApis(globalThis);
if (unblocked.length > 0) console.warn('Worker の通信 API を塞げませんでした', unblocked);

addEventListener('message', (event: MessageEvent<unknown>) => {
  handleConversionRequest(
    event.data,
    (message) => postMessage(message),
    (error) => console.error('変換に失敗しました', error),
  );
});
