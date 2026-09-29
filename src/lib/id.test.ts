import { describe, expect, it } from 'vitest';
import { createGroupId, createId, isUsableId } from './id';

describe('createId', () => {
  it('常に8文字を返す', () => {
    for (let i = 0; i < 1000; i++) {
      expect(createId()).toHaveLength(8);
    }
  });

  it('英小文字と数字だけを使う（セレクタやオブジェクトキーで安全に扱える）', () => {
    for (let i = 0; i < 200; i++) {
      expect(createId()).toMatch(/^[a-z0-9]{8}$/);
    }
  });

  it('連続で呼んでもまず衝突しない', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => createId()));
    expect(ids.size).toBe(2000);
  });
});

describe('createGroupId', () => {
  it('g で始まり、残りは createId と同じ形', () => {
    expect(createGroupId()).toMatch(/^g[a-z0-9]{8}$/);
  });
});

describe('isUsableId', () => {
  it('このアプリが作る ID は使える', () => {
    expect(isUsableId(createId())).toBe(true);
    expect(isUsableId(createGroupId())).toBe(true);
    expect(isUsableId('g1')).toBe(true);
  });

  it('空文字と、普通のオブジェクトが継承しているプロパティ名は使えない', () => {
    for (const id of ['', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(isUsableId(id)).toBe(false);
    }
  });
});
