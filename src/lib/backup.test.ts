import { describe, expect, it } from 'vitest';
import type { PersistedWorkspace } from '../types';
import { BACKUP_VERSION, buildBackup, buildRecoveryBackup, parseBackup } from './backup';

const WORKSPACE: PersistedWorkspace = {
  inputs: [{ id: 'i1', title: 'a.md', text: 'アリス' }],
  groups: [{ id: 'g1', name: 'A用' }],
  rules: [
    { id: 'r1', src: 'アリス', regex: false, cs: true, order: 'sim', values: { g1: 'あー' } },
    { id: 'r2', src: '', regex: false, cs: true, order: 'sim', values: {} },
  ],
  theme: 'dark',
  isSample: false,
};

const AT = new Date('2026-09-26T12:00:00.000Z');

describe('buildBackup / parseBackup', () => {
  it('書き出したものをそのまま読み戻せる', () => {
    const parsed = parseBackup(buildBackup(WORKSPACE, AT));
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(parsed.workspace).toEqual(WORKSPACE);
    expect(parsed.summary).toEqual({ inputs: 1, groups: 1, rules: 1, savedAt: AT.toISOString() });
  });

  it('何のファイルか分かる形で書き出す', () => {
    const json: unknown = JSON.parse(buildBackup(WORKSPACE, AT));
    expect(json).toMatchObject({ app: 'bulk-text-replacement-tool', version: BACKUP_VERSION });
  });

  it('JSON として壊れていれば読み込まない', () => {
    expect(parseBackup('{')).toEqual({
      kind: 'error',
      message: 'JSON として読めません。ファイルを確認してください。',
    });
  });

  it('別のツールの JSON は受け付けない', () => {
    expect(parseBackup(JSON.stringify({ app: 'other', version: 1 })).kind).toBe('error');
  });

  it('GitHub の出自を保ったまま往復できる（版 2）', () => {
    const source = {
      kind: 'github' as const,
      repositoryId: 42,
      owner: 'octo',
      repo: 'novel',
      ref: 'main',
      commitSha: 'a'.repeat(40),
      path: 'chapters/ch1.md',
      blobSha: 'b'.repeat(40),
    };
    const withSource: PersistedWorkspace = {
      ...WORKSPACE,
      inputs: [...WORKSPACE.inputs, { id: 'i2', title: 'ch1.md', text: '本文', source }],
    };
    const text = buildBackup(withSource, AT);
    expect(JSON.parse(text)).toMatchObject({ version: 2 });
    const parsed = parseBackup(text);
    expect(parsed.kind === 'ok' && parsed.workspace).toEqual(withSource);
  });

  it('版 1 の作業データも読める（出自の無い入力として）', () => {
    const text = JSON.stringify({
      app: 'bulk-text-replacement-tool',
      version: 1,
      savedAt: AT.toISOString(),
      workspace: WORKSPACE,
    });
    const parsed = parseBackup(text);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(parsed.workspace).toEqual(WORKSPACE);
    expect(parsed.workspace.inputs[0]).not.toHaveProperty('source');
  });

  it('壊れた出自は落とし、入力の本文は残す', () => {
    const text = JSON.stringify({
      app: 'bulk-text-replacement-tool',
      version: 2,
      workspace: {
        ...WORKSPACE,
        inputs: [{ id: 'i1', title: 'a.md', text: '残す', source: { kind: 'github' } }],
      },
    });
    const parsed = parseBackup(text);
    expect(parsed.kind === 'ok' && parsed.workspace.inputs).toEqual([
      { id: 'i1', title: 'a.md', text: '残す' },
    ]);
  });

  it('知らない版は受け付けない', () => {
    const text = JSON.stringify({ app: 'bulk-text-replacement-tool', version: 999, workspace: {} });
    const parsed = parseBackup(text);
    expect(parsed.kind).toBe('error');
    if (parsed.kind !== 'error') return;
    expect(parsed.message).toContain('対応していない版');
  });

  it('配列や null は作業データとして扱わない', () => {
    expect(parseBackup('[]').kind).toBe('error');
    expect(parseBackup('null').kind).toBe('error');
  });

  it('グループが無いものは復元しても使えないので拒否する', () => {
    const text = JSON.stringify({
      app: 'bulk-text-replacement-tool',
      version: BACKUP_VERSION,
      workspace: { inputs: [], groups: [], rules: [], theme: 'light' },
    });
    expect(parseBackup(text).kind).toBe('error');
  });

  it('欠けたフィールドは保存データと同じ規則で補う', () => {
    const text = JSON.stringify({
      app: 'bulk-text-replacement-tool',
      version: BACKUP_VERSION,
      workspace: { inputs: [{ id: 'i1', title: 'a.md' }], groups: [{ id: 'g1' }], rules: [] },
    });
    const parsed = parseBackup(text);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(parsed.workspace.inputs[0]?.text).toBe('');
    expect(parsed.workspace.groups[0]?.name).toBe('');
    expect(parsed.workspace.theme).toBe('light');
  });

  it('savedAt が無くても読める', () => {
    const text = JSON.stringify({
      app: 'bulk-text-replacement-tool',
      version: BACKUP_VERSION,
      workspace: WORKSPACE,
    });
    const parsed = parseBackup(text);
    expect(parsed.kind === 'ok' && parsed.summary.savedAt).toBeNull();
  });
});

describe('buildRecoveryBackup', () => {
  const AT = new Date('2026-01-02T03:04:05.000Z');

  it('保存データの生の JSON を封筒に包み、通常の読み込みで読み戻せる', () => {
    const raw = JSON.stringify({
      theme: 'dark',
      inputs: [{ id: 'i1', title: 'a.txt', text: 'あ' }],
      groups: [{ id: 'g1', name: 'G用' }],
      rules: [],
    });
    const parsed = parseBackup(buildRecoveryBackup(raw, AT));
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(parsed.workspace.inputs).toEqual([{ id: 'i1', title: 'a.txt', text: 'あ' }]);
    expect(parsed.workspace.theme).toBe('dark');
    expect(parsed.summary.savedAt).toBe(AT.toISOString());
  });

  it('中身は正規化せずにそのまま入れる（手で直す材料を残す）', () => {
    const raw = JSON.stringify({ inputs: 'broken', extra: { keep: true } });
    const wrapped = JSON.parse(buildRecoveryBackup(raw, AT)) as Record<string, unknown>;
    expect(wrapped).toMatchObject({ version: BACKUP_VERSION, savedAt: AT.toISOString() });
    expect(wrapped.workspace).toEqual({ inputs: 'broken', extra: { keep: true } });
    // 壊れた中身は、読み込むときに通常の書き出しと同じ検証で断る。
    expect(parseBackup(JSON.stringify(wrapped)).kind).toBe('error');
  });

  it('JSON として読めない保存データは、包めないのでそのまま返す', () => {
    expect(buildRecoveryBackup('{broken', AT)).toBe('{broken');
  });
});
