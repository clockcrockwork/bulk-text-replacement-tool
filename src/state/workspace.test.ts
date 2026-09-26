import { describe, expect, it, vi } from 'vitest';
import type { Group, InputText, Rule } from '../types';
import {
  createEmptyRule,
  createGroup,
  createInput,
  initWorkspace,
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
    editorCaret: { caret: 0, scrollRatio: 0 },
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

describe('workspaceReducer（画面の状態）', () => {
  it('タブを切り替える', () => {
    expect(workspaceReducer(state(), { type: 'tab/set', tab: 'rules' }).tab).toBe('rules');
  });

  it('ルールの表示形式を切り替える', () => {
    expect(workspaceReducer(state(), { type: 'ruleView/set', view: 'card' }).ruleView).toBe('card');
  });

  it('エディタを開くと対象と表示位置を覚える', () => {
    const next = workspaceReducer(state({ inputs: [input('i1')] }), {
      type: 'editor/open',
      id: 'i1',
      caret: 12,
      scrollRatio: 0.5,
    });
    expect(next.editingId).toBe('i1');
    expect(next.editorCaret).toEqual({ caret: 12, scrollRatio: 0.5 });
  });

  it('エディタを閉じる', () => {
    const next = workspaceReducer(state({ editingId: 'i1' }), { type: 'editor/close' });
    expect(next.editingId).toBeNull();
  });

  it('出力グループを選び直す', () => {
    expect(workspaceReducer(state(), { type: 'output/selectGroup', id: 'g2' }).outGroupId).toBe(
      'g2',
    );
  });

  it('ファイルごとの表示モードを覚える', () => {
    const first = workspaceReducer(state(), {
      type: 'output/setFileView',
      key: 'g1:0',
      view: 'plain',
    });
    const second = workspaceReducer(first, {
      type: 'output/setFileView',
      key: 'g1:1',
      view: 'highlight',
    });
    expect(second.fileViews).toEqual({ 'g1:0': 'plain', 'g1:1': 'highlight' });
  });
});

describe('workspaceReducer（入力・グループ・ルールの編集）', () => {
  it('入力を1件足す', () => {
    const added = input('new');
    const next = workspaceReducer(state({ inputs: [input('i1')] }), {
      type: 'inputs/add',
      input: added,
    });
    expect(next.inputs.map((item) => item.id)).toEqual(['i1', 'new']);
  });

  it('入力のタイトルと本文を部分更新する', () => {
    const next = workspaceReducer(state({ inputs: [input('i1', 'old')] }), {
      type: 'inputs/update',
      id: 'i1',
      patch: { text: 'new' },
    });
    expect(next.inputs[0]).toEqual({ id: 'i1', title: 'i1.txt', text: 'new' });
  });

  it('入力を全消しするとエディタも閉じる', () => {
    const next = workspaceReducer(state({ inputs: [input('i1')], editingId: 'i1' }), {
      type: 'inputs/clear',
    });
    expect(next.inputs).toEqual([]);
    expect(next.editingId).toBeNull();
  });

  it('空のファイル取り込みは状態を変えない', () => {
    const base = state({ inputs: [input('i1', 'text')] });
    expect(workspaceReducer(base, { type: 'inputs/addMany', inputs: [] })).toBe(base);
  });

  it('グループを足す・名前を変える', () => {
    const added = { id: 'g3', name: 'C用' };
    const withGroup = workspaceReducer(state(), { type: 'groups/add', group: added });
    expect(withGroup.groups).toHaveLength(3);
    const renamed = workspaceReducer(withGroup, {
      type: 'groups/rename',
      id: 'g3',
      name: 'C改',
    });
    expect(renamed.groups[2]?.name).toBe('C改');
  });

  it('ルールを足す・オプションを変える・消す', () => {
    const added = rule('r1');
    const withRule = workspaceReducer(state(), { type: 'rules/add', rule: added });
    expect(withRule.rules).toHaveLength(1);

    const updated = workspaceReducer(withRule, {
      type: 'rules/update',
      id: 'r1',
      patch: { regex: true, order: 'seq' },
    });
    expect(updated.rules[0]).toMatchObject({ regex: true, order: 'seq', src: 'a' });

    const removed = workspaceReducer(updated, { type: 'rules/remove', id: 'r1' });
    expect(removed.rules).toEqual([]);
  });
});

describe('workspaceReducer（表インポート）', () => {
  it('開閉と入力内容・モードを保持する', () => {
    const opened = workspaceReducer(state(), { type: 'import/open' });
    expect(opened.importOpen).toBe(true);

    const typed = workspaceReducer(opened, { type: 'import/setText', text: 'a,b' });
    expect(typed.importText).toBe('a,b');

    const mode = workspaceReducer(typed, { type: 'import/setMode', mode: 'replace' });
    expect(mode.importMode).toBe('replace');

    const closed = workspaceReducer(mode, { type: 'import/close' });
    expect(closed.importOpen).toBe(false);
    // 閉じただけなら入力は残す（開き直したときに消えていると困る）
    expect(closed.importText).toBe('a,b');
  });

  it('取り込みを適用するとグループとルールを差し替え、モーダルを閉じて入力を捨てる', () => {
    const before = state({ importOpen: true, importText: 'a,b', rules: [rule('old')] });
    const next = workspaceReducer(before, {
      type: 'import/apply',
      groups: [{ id: 'gx', name: 'X' }],
      rules: [rule('new', '新')],
    });
    expect(next.groups).toEqual([{ id: 'gx', name: 'X' }]);
    expect(next.rules.map((item) => item.src)).toEqual(['新']);
    expect(next.importOpen).toBe(false);
    expect(next.importText).toBe('');
    // 取り込みは既存の変換結果を消さない（未反映バッジで気づける）
    expect(next.result).toBeNull();
  });
});

describe('initWorkspace', () => {
  it('保存が無ければサンプルから始まり、画面の状態は初期値', () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const initial = initWorkspace();
    expect(initial.groups).toHaveLength(2);
    expect(initial.rules.filter((item) => item.src)).toHaveLength(2);
    expect(initial.inputs).toHaveLength(1);
    expect(initial.tab).toBe('input');
    expect(initial.ruleView).toBe('auto');
    // 取り込みの既定は非破壊側。置き換えは明示的に選ばせる。
    expect(initial.importMode).toBe('append');
    expect(initial.result).toBeNull();
    expect(initial.editingId).toBeNull();
    vi.unstubAllGlobals();
  });

  it('保存があればそれを使い、画面の状態だけ初期化する', () => {
    vi.stubGlobal('localStorage', {
      getItem: () =>
        JSON.stringify({
          inputs: [{ id: 'i1', title: 'a.md', text: 'x' }],
          groups: [{ id: 'g1', name: '保存' }],
          rules: [],
          theme: 'dark',
        }),
    });
    const initial = initWorkspace();
    expect(initial.groups).toEqual([{ id: 'g1', name: '保存' }]);
    expect(initial.theme).toBe('dark');
    expect(initial.tab).toBe('input');
    vi.unstubAllGlobals();
  });
});

describe('createGroup / createInput', () => {
  it('ID を採番して作る', () => {
    expect(createGroup('A')).toEqual({ id: expect.stringMatching(/^g[a-z0-9]{8}$/), name: 'A' });
    expect(createInput('a.md')).toEqual({
      id: expect.stringMatching(/^[a-z0-9]{8}$/),
      title: 'a.md',
      text: '',
    });
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

describe('workspace/replace', () => {
  it('作業データで入力・グループ・ルール・テーマを置き換える', () => {
    const next = workspaceReducer(
      state({ inputs: [input('i1', 'もとの本文')], rules: [rule('r1')] }),
      {
        type: 'workspace/replace',
        workspace: {
          inputs: [input('x1', '読み込んだ本文')],
          groups: [{ id: 'gz', name: 'Z用' }],
          rules: [rule('rz', 'ぜっと')],
          theme: 'dark',
        },
      },
    );
    expect(next.inputs.map((i) => i.id)).toEqual(['x1']);
    expect(next.groups.map((g) => g.id)).toEqual(['gz']);
    expect(next.rules.map((r) => r.id)).toEqual(['rz']);
    expect(next.theme).toBe('dark');
  });

  it('古い変換結果とエディタの状態を捨てる（別の原稿の結果を持ち出せないように）', () => {
    const before = state({
      editingId: 'i1',
      lastSignature: 'sig',
      outGroupId: 'g1',
      fileViews: { 'g1:0': 'plain' },
      result: {
        at: new Date(),
        groups: [{ id: 'g1', name: 'A用', dir: 'A用', files: [], hits: 0 }],
        hitsByGroupRule: {},
      },
    });
    const next = workspaceReducer(before, {
      type: 'workspace/replace',
      workspace: { inputs: [], groups: [GROUP_A], rules: [], theme: 'light' },
    });
    expect(next.result).toBeNull();
    expect(next.lastSignature).toBeNull();
    expect(next.editingId).toBeNull();
    expect(next.outGroupId).toBeNull();
    expect(next.fileViews).toEqual({});
  });
});
