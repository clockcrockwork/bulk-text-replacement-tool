import type { Group, ImportMode, Rule } from '../types';
import { createGroupId, createId } from './id';

export type Delimiter = ',' | '\t';
export type TableKind = 'markdown' | 'csv' | 'tsv';

export const TABLE_KIND_LABEL: Record<TableKind, string> = {
  markdown: 'Markdown',
  csv: 'CSV',
  tsv: 'TSV',
};

/** 見出し行で使うオプション列の名前。エクスポートとインポートで共有する。 */
export const OPTION_HEADERS = {
  regex: '正規表現',
  cs: '大小区別',
  order: '適用順',
} as const;

export const SOURCE_HEADER = '元テキスト';

export interface ParsedTable {
  rows: string[][];
  /** 判定できた表の種類。空入力なら null。 */
  kind: TableKind | null;
}

/**
 * CSV / TSV を解析する。RFC 4180 相当のクォート（`""` によるエスケープ）に対応し、
 * 全セルが空の行は落とす。
 */
export function parseDelimited(text: string, delimiter: Delimiter): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  row.push(field);
  rows.push(row);

  return rows.filter((cells) => cells.some((cell) => cell !== ''));
}

/**
 * 貼り付けられたテキストから表を推測して解析する。
 * 全行が `|` 始まりなら Markdown 表、タブを含めば TSV、それ以外は CSV とみなす。
 */
export function parseTable(text: string): ParsedTable {
  const normalized = (text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return { rows: [], kind: null };

  const lines = normalized.split('\n').filter((line) => line.trim());
  if (lines.every((line) => line.trim().startsWith('|'))) {
    const rows = lines
      .map((line) => {
        let body = line.trim().slice(1);
        if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
        return body.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
      })
      // Markdown 表の区切り行（`| --- | :--: |`）は読み飛ばす。
      .filter((cells) => !cells.every((cell) => cell === '' || /^:?-+:?$/.test(cell)));
    return { rows, kind: 'markdown' };
  }

  const delimiter: Delimiter = normalized.includes('\t') ? '\t' : ',';
  return {
    rows: parseDelimited(normalized, delimiter),
    kind: delimiter === '\t' ? 'tsv' : 'csv',
  };
}

/** 真偽値セルの表記ゆれを吸収する。 */
function isTruthyCell(value: string | undefined): boolean {
  return /^(1|true|yes|y|on|○|◯|✓|はい)$/i.test((value ?? '').trim());
}

export interface ImportTableInput {
  rows: readonly string[][];
  mode: ImportMode;
  currentGroups: readonly Group[];
  currentRules: readonly Rule[];
}

export interface ImportTableResult {
  groups: Group[];
  rules: Rule[];
  /** 取り込んだルール行数。 */
  imported: number;
}

/**
 * 解析済みの表からグループとルールを組み立てる。
 * 1列目が置換元、オプション列を除く2列目以降が各グループの置換先。
 * `append` では同名グループを再利用し、中身のある既存ルールの後ろに追加する。
 */
export function buildRulesFromTable({
  rows,
  mode,
  currentGroups,
  currentRules,
}: ImportTableInput): ImportTableResult | null {
  if (rows.length < 2) return null;
  const header = rows[0] ?? [];
  const body = rows.slice(1);

  const optionIndex = {
    regex: header.indexOf(OPTION_HEADERS.regex),
    cs: header.indexOf(OPTION_HEADERS.cs),
    order: header.indexOf(OPTION_HEADERS.order),
  };
  const optionColumns = Object.values(optionIndex).filter((index) => index >= 0);

  const groups: Group[] = mode === 'replace' ? [] : [...currentGroups];
  const groupColumns = header
    .map((title, index) => ({ title, index }))
    .filter(({ index }) => index > 0 && !optionColumns.includes(index))
    .map(({ title, index }) => {
      const name = title || `グループ${groups.length + 1}`;
      let group = groups.find((candidate) => candidate.name === name);
      if (!group) {
        group = { id: createGroupId(), name };
        groups.push(group);
      }
      return { index, groupId: group.id };
    });

  const imported: Rule[] = body
    .filter((cells) => (cells[0] ?? '') !== '')
    .map((cells) => ({
      id: createId(),
      src: cells[0] ?? '',
      regex: optionIndex.regex >= 0 && isTruthyCell(cells[optionIndex.regex]),
      cs: optionIndex.cs >= 0 ? isTruthyCell(cells[optionIndex.cs]) : true,
      order:
        optionIndex.order >= 0 && /順次|seq/i.test(cells[optionIndex.order] ?? '')
          ? ('seq' as const)
          : ('sim' as const),
      values: Object.fromEntries(
        groupColumns.map(({ index, groupId }) => [groupId, cells[index] ?? '']),
      ),
    }));

  if (groups.length === 0) groups.push({ id: createGroupId(), name: 'グループ1' });

  const rules =
    mode === 'replace'
      ? imported
      : [
          ...currentRules.filter(
            (rule) => rule.src || Object.values(rule.values).some((value) => value),
          ),
          ...imported,
        ];

  return { groups, rules, imported: imported.length };
}

/** ルール表を CSV / TSV 文字列に書き出す。行区切りは Excel 向けに CRLF。 */
export function rulesToDelimited(
  groups: readonly Group[],
  rules: readonly Rule[],
  delimiter: Delimiter,
): string {
  const header = [
    SOURCE_HEADER,
    ...groups.map((group) => group.name),
    OPTION_HEADERS.regex,
    OPTION_HEADERS.cs,
    OPTION_HEADERS.order,
  ];
  const body = rules
    .filter((rule) => rule.src)
    .map((rule) => [
      rule.src,
      ...groups.map((group) => rule.values[group.id] ?? ''),
      rule.regex ? '1' : '0',
      rule.cs ? '1' : '0',
      rule.order === 'seq' ? '順次' : '同時',
    ]);

  const quote = (value: string): string =>
    delimiter === ','
      ? /[",\n\r]/.test(value)
        ? `"${value.replace(/"/g, '""')}"`
        : value
      : // TSV はクォートを解釈しない実装が多いので、区切りになる文字を空白に潰す。
        value.replace(/[\t\n\r]/g, ' ');

  return [header, ...body].map((row) => row.map(quote).join(delimiter)).join('\r\n');
}
