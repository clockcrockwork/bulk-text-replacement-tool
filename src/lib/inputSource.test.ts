import { describe, expect, it } from 'vitest';
import type { GitHubInputSource, InputText } from '../types';
import {
  baseName,
  findSameSource,
  formatSourceDetail,
  formatSourceLabel,
  isGitSha,
  isRepositoryPath,
  matchBatchSources,
  normalizeInputSource,
  shortSha,
  sourceIdentity,
} from './inputSource';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const SOURCE: GitHubInputSource = {
  kind: 'github',
  repositoryId: 42,
  owner: 'octo',
  repo: 'novel',
  ref: 'main',
  commitSha: SHA_A,
  path: 'chapters/ch1.md',
  blobSha: SHA_B,
};

describe('isGitSha / isRepositoryPath', () => {
  it('SHA-1 と SHA-256 の16進表記だけを通す', () => {
    expect(isGitSha(SHA_A)).toBe(true);
    expect(isGitSha('c'.repeat(64))).toBe(true);
    expect(isGitSha('A'.repeat(40))).toBe(false);
    expect(isGitSha('a'.repeat(39))).toBe(false);
    expect(isGitSha(1)).toBe(false);
  });

  it('リポジトリ内のパスとして妥当なものだけを通す', () => {
    expect(isRepositoryPath('a/b.md')).toBe(true);
    expect(isRepositoryPath('')).toBe(false);
    expect(isRepositoryPath('/a.md')).toBe(false);
    expect(isRepositoryPath('a//b.md')).toBe(false);
    expect(isRepositoryPath('a/../b.md')).toBe(false);
    expect(isRepositoryPath('./a.md')).toBe(false);
  });
});

describe('normalizeInputSource', () => {
  it('正しい出自はそのまま返し、未知のフィールドは落とす', () => {
    expect(normalizeInputSource({ ...SOURCE, extra: 'x' })).toEqual(SOURCE);
  });

  it('無い・種類が違うものは出自なし', () => {
    expect(normalizeInputSource(undefined)).toBeUndefined();
    expect(normalizeInputSource(null)).toBeUndefined();
    expect(normalizeInputSource([SOURCE])).toBeUndefined();
    expect(normalizeInputSource({ ...SOURCE, kind: 'gitlab' })).toBeUndefined();
  });

  it.each([
    ['repositoryId が文字列', { repositoryId: '42' }],
    ['repositoryId が0', { repositoryId: 0 }],
    ['repositoryId が小数', { repositoryId: 1.5 }],
    ['owner が空', { owner: '' }],
    ['repo が無い', { repo: undefined }],
    ['ref が数値', { ref: 1 }],
    ['commitSha が短い', { commitSha: 'abc' }],
    ['blobSha が無い', { blobSha: undefined }],
    ['path が絶対パス', { path: '/etc/passwd' }],
    ['path に ..', { path: '../x.md' }],
  ])('%s なら出自なし', (_, patch) => {
    expect(normalizeInputSource({ ...SOURCE, ...patch })).toBeUndefined();
  });
});

describe('sourceIdentity / findSameSource', () => {
  const input = (id: string, source?: GitHubInputSource): InputText =>
    source ? { id, title: 'ch1.md', text: '', source } : { id, title: 'ch1.md', text: '' };

  it('コミットと blob が違っても同じ取り込み元', () => {
    const moved: GitHubInputSource = { ...SOURCE, commitSha: SHA_B, blobSha: SHA_A };
    expect(sourceIdentity(moved)).toBe(sourceIdentity(SOURCE));
  });

  it('リポジトリ・ブランチ・パスのどれかが違えば別物', () => {
    const base = sourceIdentity(SOURCE);
    expect(sourceIdentity({ ...SOURCE, repositoryId: 43 })).not.toBe(base);
    expect(sourceIdentity({ ...SOURCE, ref: 'draft' })).not.toBe(base);
    expect(sourceIdentity({ ...SOURCE, path: 'other/ch1.md' })).not.toBe(base);
  });

  it('区切り文字を含む名前でも取り違えない', () => {
    expect(sourceIdentity({ repositoryId: 1, ref: 'a/b', path: 'c.md' })).not.toBe(
      sourceIdentity({ repositoryId: 1, ref: 'a', path: 'b/c.md' }),
    );
  });

  it('ファイル名が同じでも出自が違う・無いものは同じ取り込み元ではない', () => {
    const inputs = [
      input('local'),
      input('same', SOURCE),
      input('other', { ...SOURCE, path: 'drafts/ch1.md' }),
      input('same2', { ...SOURCE, commitSha: SHA_B }),
    ];
    expect(findSameSource(inputs, SOURCE).map((found) => found.id)).toEqual(['same', 'same2']);
  });
});

describe('表示', () => {
  it('パスの末尾を名前にする', () => {
    expect(baseName('a/b/c.md')).toBe('c.md');
    expect(baseName('c.md')).toBe('c.md');
  });

  it('リポジトリとパス、ブランチと短いコミットを見せる', () => {
    expect(shortSha(SHA_A)).toBe('aaaaaaa');
    expect(formatSourceLabel(SOURCE)).toBe('octo/novel · chapters/ch1.md');
    expect(formatSourceDetail(SOURCE)).toBe('octo/novel の main（aaaaaaa）: chapters/ch1.md');
  });
});

describe('matchBatchSources', () => {
  const label = (item: InputText, index: number): string => `${index + 1}:${item.title}`;
  const at = (path: string): GitHubInputSource => ({ ...SOURCE, path });
  const candidate = (path: string) => ({ title: baseName(path), source: at(path) });

  it('同じ取り込み元の入力をすべて挙げ、ラベルは呼び出し側の関数で作る', () => {
    const inputs: InputText[] = [
      { id: 'one', title: 'custom-one.md', text: '', source: at('chapters/ch1.md') },
      {
        id: 'two',
        title: 'custom-two.md',
        text: '',
        source: { ...at('chapters/ch1.md'), commitSha: SHA_B },
      },
      { id: 'other', title: 'ch2.md', text: '', source: at('chapters/ch2.md') },
    ];
    const [match] = matchBatchSources(inputs, [candidate('chapters/ch1.md')], label);
    expect(match).toEqual({
      path: 'chapters/ch1.md',
      sameSource: [
        { id: 'one', label: '1:custom-one.md', position: 1 },
        { id: 'two', label: '2:custom-two.md', position: 2 },
      ],
      titleCollision: false,
    });
  });

  it('同じファイル名の、出自の無い入力や別の取り込み元の入力があれば衝突として知らせる', () => {
    const local: InputText = { id: 'local', title: 'ch1.md', text: '' };
    const elsewhere: InputText = { id: 'b', title: 'ch1.md', text: '', source: at('b/ch1.md') };
    expect(matchBatchSources([local], [candidate('a/ch1.md')], label)[0]?.titleCollision).toBe(
      true,
    );
    expect(matchBatchSources([elsewhere], [candidate('a/ch1.md')], label)[0]?.titleCollision).toBe(
      true,
    );
  });

  it('同じ取り込み元の入力と名前が同じなだけなら、衝突とはみなさない', () => {
    const same: InputText = { id: 'a', title: 'ch1.md', text: '', source: at('a/ch1.md') };
    expect(matchBatchSources([same], [candidate('a/ch1.md')], label)[0]?.titleCollision).toBe(
      false,
    );
  });

  it('同名かどうかは、実際の出力ファイル名の規則（大小文字・使えない記号）で比べる', () => {
    // 出力では大文字小文字を区別せず、`?` や `*` は `_` に置き換わるので、どれも同じ名前になる。
    const matches = matchBatchSources(
      [],
      [candidate('a/A.md'), candidate('b/a.md'), candidate('c/x?.md'), candidate('d/x*.md')],
      label,
    );
    expect(matches.map((match) => match.titleCollision)).toEqual([true, true, true, true]);

    const local: InputText = { id: 'local', title: 'CH1.MD', text: '' };
    expect(matchBatchSources([local], [candidate('a/ch1.md')], label)[0]?.titleCollision).toBe(
      true,
    );
  });

  it('同じ一括の中で basename が重なる候補も、互いに衝突として知らせる', () => {
    const matches = matchBatchSources(
      [],
      [candidate('a/ch1.md'), candidate('b/ch1.md'), candidate('c/ch2.md')],
      label,
    );
    expect(matches.map((match) => match.titleCollision)).toEqual([true, true, false]);
    expect(matches.every((match) => match.sameSource.length === 0)).toBe(true);
  });
});
