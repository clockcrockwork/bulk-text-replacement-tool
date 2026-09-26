import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWorkspace, preferredTheme, STORAGE_KEY, saveWorkspace } from './storage';

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

describe('saveWorkspace', () => {
  it('保存した内容を読み戻せる', () => {
    const store = stubStorage();
    const workspace = {
      inputs: [{ id: 'i1', title: 'a.md', text: 'x' }],
      groups: [{ id: 'g1', name: 'A' }],
      rules: [],
      theme: 'light' as const,
    };
    saveWorkspace(workspace);
    expect(JSON.parse(store[STORAGE_KEY] ?? '{}')).toEqual(workspace);
  });

  it('書き込みに失敗しても例外を投げない（入力を失わせない）', () => {
    stubStorage({}, true);
    expect(() =>
      saveWorkspace({ inputs: [], groups: [], rules: [], theme: 'light' }),
    ).not.toThrow();
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
