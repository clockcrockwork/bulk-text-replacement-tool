#!/usr/bin/env node
/**
 * テキストの衛生チェック。Biome が届かない範囲を見る。
 *
 * Biome は Markdown / YAML を処理せず、JS/TS の文字列リテラルやコメントの中も見ない。
 * ここでは git 管理下の全テキストファイルを対象に、不可視文字と双方向制御文字
 * （Trojan Source / CVE-2021-42574）、および CRLF を検出する。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** 見た目に現れないまま、表示や解釈を変えてしまう文字。 */
const FORBIDDEN = new Map([
  [0x00ad, 'SOFT HYPHEN'],
  [0x200b, 'ZERO WIDTH SPACE'],
  [0x200c, 'ZERO WIDTH NON-JOINER'],
  [0x200d, 'ZERO WIDTH JOINER'],
  [0x200e, 'LEFT-TO-RIGHT MARK'],
  [0x200f, 'RIGHT-TO-LEFT MARK'],
  [0x2028, 'LINE SEPARATOR'],
  [0x2029, 'PARAGRAPH SEPARATOR'],
  [0x202a, 'LEFT-TO-RIGHT EMBEDDING'],
  [0x202b, 'RIGHT-TO-LEFT EMBEDDING'],
  [0x202c, 'POP DIRECTIONAL FORMATTING'],
  [0x202d, 'LEFT-TO-RIGHT OVERRIDE'],
  [0x202e, 'RIGHT-TO-LEFT OVERRIDE'],
  [0x2066, 'LEFT-TO-RIGHT ISOLATE'],
  [0x2067, 'RIGHT-TO-LEFT ISOLATE'],
  [0x2068, 'FIRST STRONG ISOLATE'],
  [0x2069, 'POP DIRECTIONAL ISOLATE'],
  [0xfeff, 'ZERO WIDTH NO-BREAK SPACE (BOM)'],
]);

// git 管理下だけを見れば、node_modules や dist を自前で除外しなくて済む。
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const problems = [];

for (const file of files) {
  const raw = readFileSync(file);
  if (raw.includes(0)) continue; // バイナリは対象外
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    problems.push(`${file}: UTF-8 として読めない`);
    continue;
  }
  if (text.includes('\r\n')) {
    problems.push(`${file}: CRLF が含まれている（.gitattributes で LF に固定している）`);
  }
  let line = 1;
  for (const ch of text) {
    if (ch === '\n') {
      line += 1;
      continue;
    }
    const code = ch.codePointAt(0);
    const name = FORBIDDEN.get(code);
    if (name) {
      const hex = code.toString(16).toUpperCase().padStart(4, '0');
      problems.push(`${file}:${line}: 不可視文字 ${name} (U+${hex})`);
    }
  }
}

if (problems.length > 0) {
  console.error('テキストの衛生チェックで問題が見つかりました:');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('');
  console.error(
    '不可視文字はエスケープ表記で書いてください（BOM は src/lib/text.ts の BOM 定数を使う）。',
  );
  process.exit(1);
}
