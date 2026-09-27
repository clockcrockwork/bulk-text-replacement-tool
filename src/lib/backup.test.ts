import { describe, expect, it } from 'vitest';
import type { PersistedWorkspace } from '../types';
import { BACKUP_VERSION, buildBackup, parseBackup } from './backup';

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
