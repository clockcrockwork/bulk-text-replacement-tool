import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversionWorkerMessage } from '../lib/conversionProtocol';
import type { ConversionResult } from '../types';
import { type ConversionWorker, startConversion } from './conversionClient';

/** メインスレッドから見た Worker の偽物。届けるメッセージをテストが決める。 */
class FakeWorker implements ConversionWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly posted: unknown[] = [];
  terminated = false;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  send(message: ConversionWorkerMessage | unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: message }));
  }

  fail(): void {
    const event = Object.assign(new Event('error', { cancelable: true }), {
      message: '',
      filename: '',
      lineno: 0,
      colno: 0,
      error: null,
    });
    this.onerror?.(event);
  }
}

const INPUT = { inputs: [], groups: [], rules: [] };
const RESULT: ConversionResult = { at: new Date(0), groups: [], hitsByGroupRule: {} };
const PROGRESS = { groupIndex: 0, inputIndex: 1, ruleIds: ['r1'] };

function start(stallMs = 1000) {
  const worker = new FakeWorker();
  const progress: unknown[] = [];
  const run = startConversion(INPUT, {
    stallMs,
    createWorker: () => worker,
    onProgress: (value) => progress.push(value),
  });
  return { worker, run, progress };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('startConversion', () => {
  it('入力を Worker へ送り、結果が届いたら Worker を捨てて返す', async () => {
    const { worker, run } = start();
    expect(worker.posted).toEqual([INPUT]);
    worker.send({ kind: 'done', result: RESULT });
    await expect(run.outcome).resolves.toEqual({ kind: 'done', result: RESULT });
    expect(worker.terminated).toBe(true);
  });

  it('進みが届くたびに数え直すので、長くても進んでいれば止めない', async () => {
    const { worker, run, progress } = start(1000);
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(900);
      worker.send({ kind: 'progress', progress: PROGRESS });
    }
    expect(progress).toHaveLength(5);
    expect(worker.terminated).toBe(false);
    worker.send({ kind: 'done', result: RESULT });
    await expect(run.outcome).resolves.toMatchObject({ kind: 'done' });
  });

  it('1つのパスで進みが止まったら、Worker を捨てて最後のパスを添えて知らせる', async () => {
    const { worker, run } = start(1000);
    worker.send({ kind: 'progress', progress: PROGRESS });
    vi.advanceTimersByTime(1000);
    await expect(run.outcome).resolves.toEqual({
      kind: 'stopped',
      stop: { kind: 'stalled', ms: 1000, progress: PROGRESS },
    });
    expect(worker.terminated).toBe(true);
    // 捨てたあとに届いたものは使わない。
    worker.send({ kind: 'done', result: RESULT });
  });

  it('一度も進みが届かなくても、時間が来たら止める', async () => {
    const { run } = start(1000);
    vi.advanceTimersByTime(1000);
    await expect(run.outcome).resolves.toEqual({
      kind: 'stopped',
      stop: { kind: 'stalled', ms: 1000, progress: null },
    });
  });

  it('結果が大きすぎた・失敗した、は止まった理由として返す', async () => {
    const tooLarge = start();
    tooLarge.worker.send({ kind: 'tooLarge', ruleId: 'r1', groupId: 'g', inputIndex: 0 });
    await expect(tooLarge.run.outcome).resolves.toEqual({
      kind: 'stopped',
      stop: { kind: 'tooLarge', ruleId: 'r1', groupId: 'g', inputIndex: 0 },
    });
    const failed = start();
    failed.worker.send({ kind: 'failed' });
    await expect(failed.run.outcome).resolves.toEqual({
      kind: 'stopped',
      stop: { kind: 'failed' },
    });
  });

  it('Worker のエラー（読み込めない・想定外の例外）でも待ち続けない', async () => {
    const { worker, run } = start();
    worker.fail();
    await expect(run.outcome).resolves.toEqual({ kind: 'stopped', stop: { kind: 'failed' } });
    expect(worker.terminated).toBe(true);
  });

  it('結果を受け取れなかったら（messageerror）、時間切れを待たずに失敗として返す', async () => {
    const { worker, run } = start(1000);
    worker.send({ kind: 'progress', progress: PROGRESS });
    worker.onmessageerror?.(new MessageEvent('messageerror'));
    await expect(run.outcome).resolves.toEqual({ kind: 'stopped', stop: { kind: 'failed' } });
    expect(worker.terminated).toBe(true);
  });

  it('取り消したら Worker を捨て、そのあとの結果も時間切れも使わない', async () => {
    const { worker, run } = start(1000);
    run.cancel();
    worker.send({ kind: 'done', result: RESULT });
    vi.advanceTimersByTime(5000);
    await expect(run.outcome).resolves.toEqual({ kind: 'cancelled' });
    expect(worker.terminated).toBe(true);
  });

  it('知らない形のメッセージは無視する', async () => {
    const { worker, run } = start();
    worker.send({ kind: 'unknown' });
    worker.send('done');
    worker.send({ kind: 'done', result: RESULT });
    await expect(run.outcome).resolves.toMatchObject({ kind: 'done' });
  });

  it('Worker を作れなければ失敗として返す（メインスレッドへ戻さない）', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = startConversion(INPUT, {
      createWorker: () => {
        throw new Error('Worker は使えません');
      },
    });
    await expect(run.outcome).resolves.toEqual({ kind: 'stopped', stop: { kind: 'failed' } });
    run.cancel();
    error.mockRestore();
  });
});
