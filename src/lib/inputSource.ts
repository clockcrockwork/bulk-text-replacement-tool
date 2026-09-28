import type { GitHubInputSource, InputText } from '../types';
import { nameCollisionKey, outputFileName } from './fileName';

/**
 * 入力の出自（どこから取り込んだか）を扱う。
 *
 * 出自は localStorage と作業データのファイルから戻ってくるので、`as` で通さず
 * 検証してから使う。壊れた出自は**入力ごと捨てずに出自だけ落とす**。本文は
 * 利用者の原稿で、出自が読めないことはそれを失う理由にならない。
 */

/** Git のオブジェクト名。SHA-1（40桁）と SHA-256（64桁）のリポジトリがある。 */
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function isGitSha(value: unknown): value is string {
  return typeof value === 'string' && SHA_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/**
 * リポジトリ内のパスとして妥当か。
 *
 * 出自のパスは表示と同一性の判定にしか使わないが、`..` や先頭 `/` を含むものは
 * GitHub が返す形ではないので、手で書き換えられたデータとみなして受け取らない。
 */
export function isRepositoryPath(value: unknown): value is string {
  if (!nonEmptyString(value)) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** 保存データから来た出自を検証する。少しでも欠けていれば undefined（出自なし）。 */
export function normalizeInputSource(value: unknown): GitHubInputSource | undefined {
  if (!isRecord(value) || value.kind !== 'github') return undefined;
  const { repositoryId, owner, repo, ref, commitSha, path, blobSha } = value;
  if (typeof repositoryId !== 'number' || !Number.isSafeInteger(repositoryId) || repositoryId <= 0)
    return undefined;
  if (!nonEmptyString(owner) || !nonEmptyString(repo) || !nonEmptyString(ref)) return undefined;
  if (!isGitSha(commitSha) || !isGitSha(blobSha) || !isRepositoryPath(path)) return undefined;
  return { kind: 'github', repositoryId, owner, repo, ref, commitSha, path, blobSha };
}

/**
 * 同じ取り込み元かを判定するキー。
 *
 * コミットと blob は含めない。ブランチが進んだあとに同じファイルを取り込み直すのは
 * 「更新」であって別物の追加ではない。区切りに使える文字がパスにもブランチ名にも
 * 現れ得るので、連結ではなく JSON の配列にして曖昧さを無くす。
 */
export function sourceIdentity(
  source: Pick<GitHubInputSource, 'repositoryId' | 'ref' | 'path'>,
): string {
  return JSON.stringify([source.repositoryId, source.ref, source.path]);
}

/** 同じ取り込み元の既存入力。複数あり得る（「別の入力として追加」を選んだ場合）。 */
export function findSameSource(
  inputs: readonly InputText[],
  source: Pick<GitHubInputSource, 'repositoryId' | 'ref' | 'path'>,
): InputText[] {
  const key = sourceIdentity(source);
  return inputs.filter((input) => input.source && sourceIdentity(input.source) === key);
}

/** 更新先の候補になる既存の入力。 */
export interface BatchUpdateTarget {
  id: string;
  label: string;
  /** 入力の一覧での番号（1 始まり）。更新先が多いとき、番号で指定するのに使う。 */
  position: number;
  /** その入力を取り込んだときの blob。候補と同じなら、GitHub 側は前回から変わっていない。 */
  blobSha: string;
}

export interface BatchSourceMatch {
  path: string;
  /** 候補（今回取得した内容）の blob。 */
  blobSha: string;
  /** 同じ取り込み元を持つ既存の入力。2件以上なら更新先を推測しない。 */
  sameSource: ReadonlyArray<BatchUpdateTarget>;
  /**
   * 出力ファイル名が、別の取り込み元の入力（既存または同じ一括の中）とぶつかるか。
   * 実際の出力名と同じ規則（`outputFileName` と `nameCollisionKey`）で比べる。
   */
  titleCollision: boolean;
}

/**
 * 一括取り込みの候補それぞれについて、同じ取り込み元の入力と、ファイル名の衝突を調べる。
 *
 * 候補は数千件になり得るので、候補ごとに入力を全走査せず、先に索引を作って引く。
 * `label` は入力の表示名（何番目の入力か、など画面の都合）を呼び出し側が決める。
 */
export function matchBatchSources(
  inputs: readonly InputText[],
  candidates: ReadonlyArray<{ title: string; source: GitHubInputSource }>,
  label: (input: InputText, index: number) => string,
): BatchSourceMatch[] {
  const bySource = new Map<string, BatchUpdateTarget[]>();
  /**
   * 出力名の衝突キー → その入力の取り込み元（出自の無い入力は null）。
   * タイトルの完全一致ではなく、実際の出力名の規則で比べる（`A.md` と `a.md`、`a?.md` と
   * `a*.md` は出力では同じ名前になり、後の方に ` (2)` が付く）。
   */
  const byOutputName = new Map<string, Array<string | null>>();
  const outputKey = (title: string, index: number): string =>
    nameCollisionKey(outputFileName(title, index));
  inputs.forEach((input, index) => {
    const identity = input.source ? sourceIdentity(input.source) : null;
    if (identity !== null) {
      const list = bySource.get(identity) ?? [];
      list.push({
        id: input.id,
        label: label(input, index),
        position: index + 1,
        blobSha: input.source?.blobSha ?? '',
      });
      bySource.set(identity, list);
    }
    const key = outputKey(input.title, index);
    const owners = byOutputName.get(key) ?? [];
    owners.push(identity);
    byOutputName.set(key, owners);
  });
  const candidateKeys = candidates.map((candidate, index) =>
    outputKey(candidate.title, inputs.length + index),
  );
  const batchNames = new Map<string, number>();
  for (const key of candidateKeys) batchNames.set(key, (batchNames.get(key) ?? 0) + 1);

  return candidates.map((candidate, index) => {
    const identity = sourceIdentity(candidate.source);
    const key = candidateKeys[index] ?? '';
    const titleCollision =
      (byOutputName.get(key) ?? []).some((other) => other !== identity) ||
      (batchNames.get(key) ?? 0) > 1;
    return {
      path: candidate.source.path,
      blobSha: candidate.source.blobSha,
      sameSource: bySource.get(identity) ?? [],
      titleCollision,
    };
  });
}

/** パスの末尾（ファイル名）。取り込んだ入力のタイトルの初期値に使う。 */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** 画面に出す短いコミット名。 */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** 入力カードに出す出自の要約。「owner/repo · path」 */
export function formatSourceLabel(source: GitHubInputSource): string {
  return `${source.owner}/${source.repo} · ${source.path}`;
}

/** 出自の詳細（ブランチとコミット）。title 属性など補足の表示に使う。 */
export function formatSourceDetail(source: GitHubInputSource): string {
  return `${source.owner}/${source.repo} の ${source.ref}（${shortSha(source.commitSha)}）: ${source.path}`;
}
