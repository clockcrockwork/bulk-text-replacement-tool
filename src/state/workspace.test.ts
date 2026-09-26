import { describe, expect, it } from 'vitest';
import type { Group, InputText, Rule } from '../types';
import {
  createEmptyRule,
  type WorkspaceState,
  workspaceReducer,
  workspaceSignature,
} from './workspace';

const GROUP_A: Group = { id: 'g1', name: 'A用' };
const GROUP_B: Group = { id: 'g2', name: 'B用' };

function input(id: string, text = ''): InputText {
  return { id, title: `${id}.txt`, text };
}

function rule(id: string, src = 'a'): Rule {
  return { id, src, regex: false, cs: true, order: 'sim', values: {} };
}

function state(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    inputs: [],
    groups: [GROUP_A, GROUP_B],
    rules: [],
    theme: 'light',
    tab: 'input',
    ruleView: 'auto',
    editingId: null,
    result: null,
    lastSignature: null,
    outGroupId: null,
    fileViews: {},
    importOpen: false,
    importText: '',
    importMode: 'replace',
    ...overrides,
  };
}

describe('workspaceReducer', () => {
  it('テーマを切り替える', () => {
    expect(workspaceReducer(state(), { type: 'theme/toggle' }).theme).toBe('dark');
  });

  it('空のテキスト欄が1つだけならファイル取り込みで置き換える', () => {
    const next = workspaceReducer(state({ inputs: [input('i1', '  ')] }), {
      type: 'inputs/addMany',
      inputs: [input('f1', 'x')],
    });
    expect(next.inputs.map((item) => item.id)).toEqual(['f1']);
    expect(next.tab).toBe('input');
  });

  it('中身のある入力は残したまま追記する', () => {
    const next = workspaceReducer(state({ inputs: [input('i1', 'text')] }), {
      type: 'inputs/addMany',
      inputs: [input('f1', 'x')],
    });
    expect(next.inputs.map((item) => item.id)).toEqual(['i1', 'f1']);
  });

  it('編集中の入力を消したらエディタも閉じる', () => {
    const next = workspaceReducer(state({ inputs: [input('i1')], editingId: 'i1' }), {
      type: 'inputs/remove',
      id: 'i1',
    });
    expect(next.editingId).toBeNull();
  });

  it('最後のグループは削除できない', () => {
    const single = state({ groups: [GROUP_A] });
    expect(workspaceReducer(single, { type: 'groups/remove', id: 'g1' }).groups).toEqual([GROUP_A]);
  });

  it('グループが2つ以上なら削除できる', () => {
    expect(workspaceReducer(state(), { type: 'groups/remove', id: 'g1' }).groups).toEqual([
      GROUP_B,
    ]);
  });

  it('グループを消したら、各ルールの置換先からもその列を消す', () => {
    const withValues: Rule = {
      id: 'r1',
      src: 'a',
      regex: false,
      cs: true,
      order: 'sim',
      values: { g1: 'X', g2: 'Y' },
    };
    const next = workspaceReducer(state({ rules: [withValues] }), {
      type: 'groups/remove',
      id: 'g1',
    });
    expect(next.rules[0]?.values).toEqual({ g2: 'Y' });
  });

  it('関係ないルールは同じ参照のまま返す', () => {
    const untouched: Rule = {
      id: 'r1',
      src: 'a',
      regex: false,
      cs: true,
      order: 'sim',
      values: { g2: 'Y' },
    };
    const next = workspaceReducer(state({ rules: [untouched] }), {
      type: 'groups/remove',
      id: 'g1',
    });
    expect(next.rules[0]).toBe(untouched);
  });

  it('セルの値だけを差し替える', () => {
    const next = workspaceReducer(state({ rules: [rule('r1')] }), {
      type: 'rules/setValue',
      ruleId: 'r1',
      groupId: 'g1',
      value: 'X',
    });
    expect(next.rules[0]?.values).toEqual({ g1: 'X' });
    expect(next.rules[0]?.src).toBe('a');
  });

  it('端をはみ出す並べ替えは無視する', () => {
    const base = state({ rules: [rule('r1'), rule('r2')] });
    expect(workspaceReducer(base, { type: 'rules/move', index: 0, delta: -1 })).toBe(base);
    expect(
      workspaceReducer(base, { type: 'rules/move', index: 0, delta: 1 }).rules.map((r) => r.id),
    ).toEqual(['r2', 'r1']);
  });

  it('結果を受け取ると出力タブへ移り、既存の選択が消えていれば先頭を選ぶ', () => {
    const result = {
      at: new Date(),
      groups: [{ id: 'g2', name: 'B用', dir: 'B用', files: [], hits: 0 }],
      hitsByGroupRule: {},
    };
    const next = workspaceReducer(state({ outGroupId: 'gone' }), {
      type: 'result/set',
      result,
      signature: 'sig',
    });
    expect(next.tab).toBe('output');
    expect(next.outGroupId).toBe('g2');
    expect(next.lastSignature).toBe('sig');
  });

  it('選択中のグループが残っていれば保持する', () => {
    const result = {
      at: new Date(),
      groups: [
        { id: 'g1', name: 'A用', dir: 'A用', files: [], hits: 0 },
        { id: 'g2', name: 'B用', dir: 'B用', files: [], hits: 0 },
      ],
      hitsByGroupRule: {},
    };
    const next = workspaceReducer(state({ outGroupId: 'g2' }), {
      type: 'result/set',
      result,
      signature: 'sig',
    });
    expect(next.outGroupId).toBe('g2');
  });
});

describe('workspaceSignature', () => {
  it('本文が変わると変化する', () => {
    const before = state({ inputs: [input('i1', 'a')] });
    const after = state({ inputs: [input('i1', 'b')] });
    expect(workspaceSignature(before)).not.toBe(workspaceSignature(after));
  });

  it('画面の状態だけが違っても変化しない', () => {
    const before = state({ inputs: [input('i1', 'a')], tab: 'input' });
    const after = state({ inputs: [input('i1', 'a')], tab: 'output', importOpen: true });
    expect(workspaceSignature(before)).toBe(workspaceSignature(after));
  });
});

describe('createEmptyRule', () => {
  it('同時適用・大小区別ありの空行を作る', () => {
    expect(createEmptyRule()).toMatchObject({ src: '', regex: false, cs: true, order: 'sim' });
  });
});
