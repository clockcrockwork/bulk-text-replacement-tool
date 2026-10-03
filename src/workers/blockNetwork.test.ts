import { describe, expect, it } from 'vitest';
import { blockNetworkApis, NETWORK_APIS } from './blockNetwork';

describe('blockNetworkApis', () => {
  it('通信の API を undefined にし、書き戻せなくする', () => {
    const scope: Record<string, unknown> = {
      fetch: () => {},
      XMLHttpRequest: class {},
      WebSocket: class {},
      EventSource: class {},
      postMessage: () => {},
    };
    expect(blockNetworkApis(scope)).toEqual([]);
    for (const name of NETWORK_APIS) {
      expect(scope[name]).toBeUndefined();
      expect(() => {
        scope[name] = () => {};
      }).toThrow();
    }
    // 変換の受け渡しに使うものは残す。
    expect(typeof scope.postMessage).toBe('function');
  });

  it('塞げなかった名前を返す', () => {
    const scope = Object.freeze({ fetch: () => {} });
    expect(blockNetworkApis(scope)).toEqual([...NETWORK_APIS]);
  });
});
