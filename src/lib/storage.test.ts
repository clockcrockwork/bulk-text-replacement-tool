import { afterEach, describe, expect, it, vi } from 'vitest';
import { isUsableId } from './id';
import { STORAGE_CONFIRM_CODE_UNITS } from './inputLimits';
import { runConversion } from './replace';
import {
  clearWorkspace,
  isForeignWorkspaceChange,
  isForeignWorkspaceValue,
  loadWorkspace,
  mayExceedStorage,
  peekWorkspace,
  preferredTheme,
  readRawWorkspace,
  STORAGE_KEY,
  saveWorkspace,
  writeWorkspace,
} from './storage';

/** localStorage を差し替える。`fail` を指定すると各操作が例外を投げる。 */
function stubStorage(initial: Record<string, string> = {}, fail = false) {
  const store = { ...initial };
  const throwing = () => {
    throw new Error('localStorage は使えません');
  };
  const setItem = (key: string, value: string): void => {
    store[key] = value;
  };
  const removeItem = (key: string): void => {
    delete store[key];
  };
  vi.stubGlobal('localStorage', {
    getItem: fail ? throwing : (key: string) => store[key] ?? null,
    setItem: fail ? throwing : setItem,
    removeItem: fail ? throwing : removeItem,
  });
  return store;
}

function saved(value: unknown): Record<string, string> {
  return { [STORAGE_KEY]: JSON.stringify(value) };
}

afterEach(() => vi.unstubAllGlobals());

describe('loadWorkspace', () => {
  it('保存が無ければ null', () => {
    stubStorage();
    expect(loadWorkspace()).toBeNull();
  });

  it('壊れた JSON なら null', () => {
    stubStorage({ [STORAGE_KEY]: '{' });
    expect(loadWorkspace()).toBeNull();
  });

  it('オブジェクトでなければ null', () => {
    stubStorage(saved([1, 2, 3]));
    expect(loadWorkspace()).toBeNull();
  });

  it('グループが無ければ null（置換先を書く場所が無い）', () => {
    stubStorage(saved({ groups: [], inputs: [], rules: [] }));
    expect(loadWorkspace()).toBeNull();
  });

  it('localStorage が例外を投げる環境でも null を返すだけで落ちない', () => {
    stubStorage({}, true);
    expect(loadWorkspace()).toBeNull();
  });

  it('正常な保存はそのまま復元する', () => {
    stubStorage(
      saved({
        inputs: [{ id: 'i1', title: 'a.md', text: 'x' }],
        groups: [{ id: 'g1', name: 'A用' }],
        rules: [{ id: 'r1', src: 'a', regex: true, cs: false, order: 'seq', values: { g1: 'X' } }],
        theme: 'dark',
      }),
    );
    expect(loadWorkspace()).toEqual({
      inputs: [{ id: 'i1', title: 'a.md', text: 'x' }],
      groups: [{ id: 'g1', name: 'A用' }],
      rules: [{ id: 'r1', src: 'a', regex: true, cs: false, order: 'seq', values: { g1: 'X' } }],
      theme: 'dark',
      // 保存データに無ければサンプル扱いしない（古い保存データは実データ）。
      isSample: false,
    });
  });

  // ここが復旧不能クラッシュの再発防止。以前は素通しして描画時に例外になっていた。
  it('欠けているフィールドを補い、描画で落ちない形にして返す', () => {
    stubStorage(
      saved({
        inputs: [{ id: 'i1' }],
        groups: [{ id: 'g1' }],
        rules: [{ id: 'r1', src: 'a' }],
      }),
    );
    const loaded = loadWorkspace();
    expect(loaded?.inputs[0]).toEqual({ id: 'i1', title: '', text: '' });
    expect(loaded?.groups[0]).toEqual({ id: 'g1', name: '' });
    expect(loaded?.rules[0]).toEqual({
      id: 'r1',
      src: 'a',
      regex: false,
      cs: true,
      order: 'sim',
      values: {},
    });
  });

  it('ID が欠けていれば採番して拾う（黙って捨てない）', () => {
    stubStorage(saved({ inputs: [{ text: 'のこす' }], groups: [{ name: 'A' }], rules: [] }));
    const loaded = loadWorkspace();
    expect(loaded?.inputs[0]?.id).toMatch(/^[a-z0-9]{8}$/);
    expect(loaded?.inputs[0]?.text).toBe('のこす');
    expect(loaded?.groups[0]?.id).toMatch(/^g[a-z0-9]{8}$/);
  });

  it('オブジェクトでない要素だけを落とす', () => {
    stubStorage(
      saved({
        inputs: ['ごみ', null, { id: 'i1', title: 't', text: 'x' }],
        groups: [{ id: 'g1', name: 'A' }],
        rules: [42],
      }),
    );
    const loaded = loadWorkspace();
    expect(loaded?.inputs).toHaveLength(1);
    expect(loaded?.rules).toHaveLength(0);
  });

  it('配列でないコレクションは空として扱う', () => {
    stubStorage(saved({ inputs: 'ごみ', groups: [{ id: 'g1', name: 'A' }], rules: null }));
    const loaded = loadWorkspace();
    expect(loaded?.inputs).toEqual([]);
    expect(loaded?.rules).toEqual([]);
  });

  it('values の文字列でない値は落とす', () => {
    stubStorage(
      saved({
        groups: [{ id: 'g1', name: 'A' }],
        rules: [{ id: 'r1', src: 'a', values: { g1: 'X', g2: 3, g3: null } }],
        inputs: [],
      }),
    );
    expect(loadWorkspace()?.rules[0]?.values).toEqual({ g1: 'X' });
  });

  it('未知のテーマは light に倒す', () => {
    stubStorage(saved({ groups: [{ id: 'g1', name: 'A' }], theme: 'solarized' }));
    expect(loadWorkspace()?.theme).toBe('light');
  });
});

describe('loadWorkspace の出自（source）', () => {
  const source = {
    kind: 'github',
    repositoryId: 42,
    owner: 'octo',
    repo: 'novel',
    ref: 'main',
    commitSha: 'a'.repeat(40),
    path: 'chapters/ch1.md',
    blobSha: 'b'.repeat(40),
  };

  it('GitHub の出自を検証して保持する', () => {
    stubStorage(
      saved({ inputs: [{ id: 'i1', title: 'ch1.md', text: 'x', source }], groups: [{ id: 'g1' }] }),
    );
    expect(loadWorkspace()?.inputs[0]).toEqual({ id: 'i1', title: 'ch1.md', text: 'x', source });
  });

  it('出自の無い古い保存データは、出自なしの入力として読む', () => {
    stubStorage(saved({ inputs: [{ id: 'i1', title: 'a', text: 'x' }], groups: [{ id: 'g1' }] }));
    expect(loadWorkspace()?.inputs[0]).not.toHaveProperty('source');
  });

  it('壊れた出自は落とすが、入力（本文）は残す', () => {
    stubStorage(
      saved({
        inputs: [{ id: 'i1', title: 'a', text: '原稿', source: { ...source, commitSha: 'x' } }],
        groups: [{ id: 'g1' }],
      }),
    );
    expect(loadWorkspace()?.inputs[0]).toEqual({ id: 'i1', title: 'a', text: '原稿' });
  });
});

describe('loadWorkspace の ID / 配列の扱い', () => {
  it('配列は要素オブジェクトとして扱わない（空行が生えない）', () => {
    stubStorage({
      [STORAGE_KEY]: JSON.stringify({
        inputs: [[], { id: 'i1', title: 'a', text: 'x' }],
        groups: [{ id: 'g1', name: 'A' }],
        rules: [[]],
        theme: 'light',
      }),
    });
    const loaded = loadWorkspace();
    expect(loaded?.inputs).toHaveLength(1);
    expect(loaded?.rules).toHaveLength(0);
  });

  it('ID が重複していたら振り直す（1行の編集が2行に波及しない）', () => {
    stubStorage({
      [STORAGE_KEY]: JSON.stringify({
        inputs: [],
        groups: [
          { id: 'g1', name: 'A' },
          { id: 'g1', name: 'B' },
        ],
        rules: [
          { id: 'r1', src: 'a', values: {} },
          { id: 'r1', src: 'b', values: {} },
        ],
        theme: 'light',
      }),
    });
    const loaded = loadWorkspace();
    const groupIds = loaded?.groups.map((group) => group.id) ?? [];
    const ruleIds = loaded?.rules.map((rule) => rule.id) ?? [];
    expect(new Set(groupIds).size).toBe(2);
    expect(new Set(ruleIds).size).toBe(2);
    expect(loaded?.rules.map((rule) => rule.src)).toEqual(['a', 'b']);
  });
});

describe('loadWorkspace の使えない ID（__proto__ など）', () => {
  // JSON.parse は `__proto__` を自身のプロパティとして作るので、保存データに入り得る。
  const raw = `{
    "inputs": [{ "id": "__proto__", "title": "a.md", "text": "アリス" }],
    "groups": [{ "id": "__proto__", "name": "A" }, { "id": "constructor", "name": "B" }],
    "rules": [
      { "id": "toString", "src": "アリス", "values": { "__proto__": "あー", "constructor": "びー", "valueOf": "x" } }
    ],
    "theme": "light"
  }`;

  it('振り直し、グループの置換先は新しい ID へ付け替えて失わない', () => {
    stubStorage({ [STORAGE_KEY]: raw });
    const loaded = loadWorkspace();
    if (!loaded) throw new Error('読み込めませんでした');
    const [groupA, groupB] = loaded.groups;
    const [rule] = loaded.rules;
    if (!groupA || !groupB || !rule) throw new Error('要素がありません');
    for (const id of [groupA.id, groupB.id, rule.id, loaded.inputs[0]?.id ?? '']) {
      expect(isUsableId(id)).toBe(true);
    }
    expect([groupA.name, groupB.name]).toEqual(['A', 'B']);
    // 対応するグループの無い使えないキー（valueOf）は落とす。
    expect(rule.values).toEqual({ [groupA.id]: 'あー', [groupB.id]: 'びー' });
    expect(Object.getPrototypeOf(rule.values)).toBe(Object.prototype);
  });

  it('振り直した保存データで、変換は置換先どおりの結果になる', () => {
    stubStorage({ [STORAGE_KEY]: raw });
    const loaded = loadWorkspace();
    if (!loaded) throw new Error('読み込めませんでした');
    const result = runConversion(loaded);
    expect(result.groups.map((group) => group.files[0]?.text)).toEqual(['あー', 'びー']);
    const [rule] = loaded.rules;
    expect(
      result.groups.map((group) => result.hitsByGroupRule[group.id]?.[rule?.id ?? '']),
    ).toEqual([1, 1]);
  });

  // 以前の ID 生成は空文字を作り得たので、空の group ID と `values['']` の保存データは実在し得る。
  it('空の group ID も振り直し、`values[""]` の置換先を新しい ID へ付け替える', () => {
    stubStorage(
      saved({
        inputs: [{ id: '', title: 'a.md', text: 'アリス' }],
        groups: [{ id: '', name: 'A' }],
        rules: [{ id: '', src: 'アリス', values: { '': 'あー' } }],
        theme: 'light',
      }),
    );
    const loaded = loadWorkspace();
    if (!loaded) throw new Error('読み込めませんでした');
    const [group] = loaded.groups;
    const [rule] = loaded.rules;
    if (!group || !rule) throw new Error('要素がありません');
    for (const id of [group.id, rule.id, loaded.inputs[0]?.id ?? '']) {
      expect(isUsableId(id)).toBe(true);
    }
    expect(rule.values).toEqual({ [group.id]: 'あー' });
    expect(runConversion(loaded).groups[0]?.files[0]?.text).toBe('あー');
  });

  it('使えない ID が重複していたら、最初のものだけ置換先を引き継ぐ', () => {
    stubStorage(
      saved({
        inputs: [],
        groups: [
          { id: '__proto__', name: 'A' },
          { id: '__proto__', name: 'B' },
        ],
        rules: [{ id: 'r1', src: 'a', values: JSON.parse('{"__proto__": "x"}') }],
        theme: 'light',
      }),
    );
    const loaded = loadWorkspace();
    const [groupA, groupB] = loaded?.groups ?? [];
    expect(groupA?.id).not.toBe(groupB?.id);
    expect(loaded?.rules[0]?.values).toEqual({ [groupA?.id ?? '']: 'x' });
  });
});

describe('saveWorkspace', () => {
  it('保存した内容を読み戻せる', () => {
    const store = stubStorage();
    const workspace = {
      inputs: [{ id: 'i1', title: 'a.md', text: 'x' }],
      groups: [{ id: 'g1', name: 'A' }],
      rules: [],
      theme: 'light' as const,
      isSample: false,
    };
    saveWorkspace(workspace);
    expect(JSON.parse(store[STORAGE_KEY] ?? '{}')).toEqual(workspace);
  });

  it('書き込みに失敗しても例外を投げない（入力を失わせない）', () => {
    stubStorage({}, true);
    expect(() =>
      saveWorkspace({ inputs: [], groups: [], rules: [], theme: 'light', isSample: false }),
    ).not.toThrow();
  });
});

describe('writeWorkspace', () => {
  const workspace = {
    inputs: [{ id: 'i1', title: 'a.md', text: 'x' }],
    groups: [{ id: 'g1', name: 'A' }],
    rules: [],
    theme: 'light' as const,
    isSample: false,
  };

  it('書いた文字列そのものを返す（storage イベントの値と比べられる）', () => {
    const store = stubStorage();
    const raw = writeWorkspace(workspace);
    expect(raw).not.toBeNull();
    expect(raw).toBe(store[STORAGE_KEY]);
  });

  it('書けなければ null を返す', () => {
    stubStorage({}, true);
    expect(writeWorkspace(workspace)).toBeNull();
    expect(saveWorkspace(workspace)).toBe(false);
  });
});

describe('isForeignWorkspaceChange', () => {
  it('作業データのキーに、このタブの知らない値が来たら他のタブの書き換え', () => {
    expect(isForeignWorkspaceChange({ key: STORAGE_KEY, newValue: 'b' }, ['a'])).toBe(true);
    // このタブがまだ何も書いていなくても、届いた値が知らないものなら食い違っている。
    expect(isForeignWorkspaceChange({ key: STORAGE_KEY, newValue: 'b' }, [null])).toBe(true);
  });

  it('知っている値が書かれただけなら数えない（読み込んだ内容の書き戻しで警告を出さない）', () => {
    expect(isForeignWorkspaceChange({ key: STORAGE_KEY, newValue: 'a' }, ['a'])).toBe(false);
    // 起動時は、読んだ生の値と今の形で書き直した値のどちらも知っている値。
    expect(isForeignWorkspaceChange({ key: STORAGE_KEY, newValue: 'a2' }, ['a1', 'a2'])).toBe(
      false,
    );
  });

  it('作業データが消されたら（removeItem / clear）他のタブの書き換えとして数える', () => {
    expect(isForeignWorkspaceChange({ key: STORAGE_KEY, newValue: null }, ['a'])).toBe(true);
    expect(isForeignWorkspaceChange({ key: null, newValue: null }, ['a'])).toBe(true);
  });

  it('このタブも保存データが無いと知っているなら、clear() は食い違いにならない', () => {
    expect(isForeignWorkspaceChange({ key: null, newValue: null }, [null, 'x'])).toBe(false);
  });

  it('作業データ以外のキーは見ない', () => {
    expect(isForeignWorkspaceChange({ key: 'other', newValue: 'b' }, ['a'])).toBe(false);
  });
});

describe('peekWorkspace / isForeignWorkspaceValue', () => {
  it('保存データの今の値を読む。無ければ raw が null', () => {
    stubStorage(saved({ a: 1 }));
    expect(peekWorkspace()).toEqual({ raw: JSON.stringify({ a: 1 }) });
    stubStorage();
    expect(peekWorkspace()).toEqual({ raw: null });
  });

  it('読めない環境では null（「無い」と取り違えない）', () => {
    stubStorage({}, true);
    expect(peekWorkspace()).toBeNull();
  });

  it('知っている値かどうかで判定する', () => {
    expect(isForeignWorkspaceValue('a', ['a'])).toBe(false);
    expect(isForeignWorkspaceValue('b', ['a'])).toBe(true);
    expect(isForeignWorkspaceValue(null, ['a'])).toBe(true);
  });
});

describe('mayExceedStorage', () => {
  /** 保存したときの長さ（キー込み）が `total` になる、本文1件のワークスペース。 */
  function sized(total: number, fill = 'a') {
    const empty = {
      inputs: [{ id: 'i1', title: 'a.md', text: '' }],
      groups: [{ id: 'g1', name: 'A' }],
      rules: [],
      theme: 'light' as const,
      isSample: false,
    };
    const base = STORAGE_KEY.length + JSON.stringify(empty).length;
    const text = fill.repeat(total - base);
    return { ...empty, inputs: [{ id: 'i1', title: 'a.md', text }] };
  }

  it('保存する長さ（キー込み）が目安ちょうどまでは確かめない', () => {
    expect(mayExceedStorage(sized(STORAGE_CONFIRM_CODE_UNITS))).toBe(false);
    expect(mayExceedStorage(sized(STORAGE_CONFIRM_CODE_UNITS + 1))).toBe(true);
  });

  it('本文の文字数ではなく、エスケープ後の JSON の長さで見る', () => {
    // 改行は JSON で `\n` の2文字になる。文字数で数えると目安の半分でも、保存する長さは超える。
    const half = STORAGE_CONFIRM_CODE_UNITS / 2 + 10;
    const workspace = {
      inputs: [{ id: 'i1', title: 'a.md', text: '\n'.repeat(half) }],
      groups: [{ id: 'g1', name: 'A' }],
      rules: [],
      theme: 'light' as const,
      isSample: false,
    };
    expect(mayExceedStorage(workspace)).toBe(true);
  });
});

describe('loadWorkspace の isSample', () => {
  it('保存されていれば引き継ぐ', () => {
    stubStorage(
      saved({ inputs: [], groups: [{ id: 'g1', name: 'A' }], rules: [], isSample: true }),
    );
    expect(loadWorkspace()?.isSample).toBe(true);
  });

  it('true 以外はサンプル扱いしない（古い保存データを実データとして守る）', () => {
    for (const value of [undefined, 'true', 1, null]) {
      stubStorage(
        saved({ inputs: [], groups: [{ id: 'g1', name: 'A' }], rules: [], isSample: value }),
      );
      expect(loadWorkspace()?.isSample).toBe(false);
    }
  });
});

describe('readRawWorkspace / clearWorkspace', () => {
  it('保存されている文字列をそのまま読める（復旧UIが退避に使う）', () => {
    stubStorage({ [STORAGE_KEY]: 'こわれたJSON' });
    expect(readRawWorkspace()).toBe('こわれたJSON');
  });

  it('読めない環境では null（落ちない）', () => {
    stubStorage({}, true);
    expect(readRawWorkspace()).toBeNull();
  });

  it('保存データを消せる', () => {
    const store = stubStorage({ [STORAGE_KEY]: '{}' });
    clearWorkspace();
    expect(store[STORAGE_KEY]).toBeUndefined();
  });

  it('消せない環境でも例外を投げない（復旧UIが道連れで落ちない）', () => {
    stubStorage({}, true);
    expect(() => clearWorkspace()).not.toThrow();
  });
});

describe('preferredTheme', () => {
  it('OS がダークなら dark', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    expect(preferredTheme()).toBe('dark');
  });

  it('OS がライトなら light', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(preferredTheme()).toBe('light');
  });

  it('matchMedia が無い環境でも落ちず light', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(preferredTheme()).toBe('light');
  });
});
