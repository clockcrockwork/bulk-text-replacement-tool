#!/usr/bin/env node
/**
 * GitHub Actions の `uses:` がコミット SHA（40 桁）で固定されているかを見る。
 *
 * タグ（`@v7`）は付け替えられる。Action のリポジトリが乗っ取られると、同じタグのまま
 * 中身を差し替えられ、次の CI からそのコードが走る（tj-actions/changed-files の事例）。
 * SHA なら、Dependabot の PR を通して差分を見てからでないと中身が変わらない。
 *
 * SHA の後ろには `# v7.0.1` のように版を書く。人が読めるようにするためと、Dependabot が
 * この注記を見て SHA と一緒に書き換えるため（注記が無いと版の対応が追えなくなる）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOW_DIR = '.github/workflows';

// `uses:` の値と、その後ろの注記を取り出す。`- uses:` と `uses:` の両方の書き方を拾う。
const USES = /^\s*(?:-\s+)?uses:\s*(['"]?)([^\s'"#]+)\1\s*(?:#\s*(.*))?$/;
const PINNED = /^[^@\s]+@[0-9a-f]{40}$/;
const VERSION_COMMENT = /^v\d+(?:\.\d+)*$/;

const files = existsSync(WORKFLOW_DIR)
  ? readdirSync(WORKFLOW_DIR)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => join(WORKFLOW_DIR, name))
  : [];

const problems = [];

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((text, index) => {
    const match = USES.exec(text);
    if (!match) return;
    const ref = match[2] ?? '';
    const comment = (match[3] ?? '').trim();
    const where = `${file}:${index + 1}`;
    // 同じリポジトリの中の Action は、このリポジトリの差分として見えるので固定しなくてよい。
    if (ref.startsWith('./')) return;
    if (!PINNED.test(ref)) {
      problems.push(`${where}: ${ref} がコミット SHA（40 桁）で固定されていない`);
      return;
    }
    if (!VERSION_COMMENT.test(comment)) {
      problems.push(`${where}: ${ref} の後ろに版の注記（例: # v7.0.1）が無い`);
    }
  });
}

if (problems.length > 0) {
  console.error('GitHub Actions の固定で問題が見つかりました:');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('');
  console.error(
    'タグの指すコミットは `git ls-remote --tags https://github.com/<owner>/<repo>.git` で確かめ、',
  );
  console.error('`uses: owner/repo@<40桁の SHA> # vX.Y.Z` の形で書いてください。');
  process.exit(1);
}
