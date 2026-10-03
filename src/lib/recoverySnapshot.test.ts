import { describe, expect, it } from 'vitest';
import type { PersistedWorkspace } from '../types';
import { createRecoverySnapshot } from './recoverySnapshot';

function workspace(overrides: Partial<PersistedWorkspace> = {}): PersistedWorkspace {
  return {
    inputs: [{ id: 'i1', title: 'a.md', text: 'x' }],
    groups: [{ id: 'g1', name: 'A' }],
    rules: [],
    theme: 'light',
    isSample: false,
    ...overrides,
  };
}

describe('createRecoverySnapshot', () => {
  it('まだ何も描画していなければ、救うものは無い', () => {
    expect(createRecoverySnapshot().unsaved()).toBeNull();
  });

  it('保存済みの状態と同じなら、保存データで足りるので null', () => {
    const snapshot = createRecoverySnapshot();
    const base = workspace();
    snapshot.noteSaved(base);
    // 永続化しない部分だけ変わったレンダーでも、取り出し直した形は別のオブジェクトになる。
    snapshot.noteRendered({ ...base });
    expect(snapshot.unsaved()).toBeNull();
  });

  it('保存に失敗したまま進んだ状態は、正規化せずにそのまま返す', () => {
    const snapshot = createRecoverySnapshot();
    const base = workspace();
    snapshot.noteSaved(base);
    // 保存データでは防いでいる形（空の ID）も、落ちた原因の手がかりなので直さない。
    const edited = workspace({ inputs: [{ id: '', title: 'b.md', text: 'y' }] });
    snapshot.noteRendered(edited);
    expect(snapshot.unsaved()).toBe(edited);
  });

  it('参照が違っても中身が同じなら、保存済みとして扱う', () => {
    const snapshot = createRecoverySnapshot();
    snapshot.noteSaved(workspace());
    snapshot.noteRendered(workspace());
    expect(snapshot.unsaved()).toBeNull();
  });

  it('テーマ・サンプル状態の違いも保存されていない変更として扱う', () => {
    const snapshot = createRecoverySnapshot();
    const base = workspace();
    snapshot.noteSaved(base);
    snapshot.noteRendered({ ...base, theme: 'dark' });
    expect(snapshot.unsaved()?.theme).toBe('dark');
    snapshot.noteRendered({ ...base, isSample: true });
    expect(snapshot.unsaved()?.isSample).toBe(true);
  });

  it('保存に成功すれば、その状態はもう救わなくてよい', () => {
    const snapshot = createRecoverySnapshot();
    const edited = workspace();
    snapshot.noteRendered(edited);
    expect(snapshot.unsaved()).toBe(edited);
    snapshot.noteSaved(edited);
    expect(snapshot.unsaved()).toBeNull();
  });

  it('別のタブに保存データを書き換えられたら、変更が無くても最新の状態を返す', () => {
    const snapshot = createRecoverySnapshot();
    const base = workspace();
    snapshot.noteSaved(base);
    snapshot.noteRendered(base);
    snapshot.forgetSaved();
    expect(snapshot.unsaved()).toBe(base);
  });
});
