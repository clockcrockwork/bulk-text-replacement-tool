import { afterEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_CONFIRM_CODE_UNITS } from './inputLimits';
import {
  clearWorkspace,
  loadWorkspace,
  mayExceedStorage,
  preferredTheme,
  readRawWorkspace,
  STORAGE_KEY,
  saveWorkspace,
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
