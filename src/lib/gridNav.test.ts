import { describe, expect, it } from 'vitest';
import { type GridNavContext, resolveGridNav } from './gridNav';

/** 3行 × （置換元 + グループ2列）= 3列の表を既定にする。 */
function ctx(overrides: Partial<GridNavContext>): GridNavContext {
  return {
    key: 'Tab',
    shiftKey: false,
    row: 0,
    col: 0,
    rows: 3,
    cols: 3,
    cards: false,
    atStart: false,
    atEnd: false,
    ...overrides,
  };
}

describe('resolveGridNav（表表示）', () => {
  it('Tab で次のセルへ', () => {
    expect(resolveGridNav(ctx({ key: 'Tab', row: 0, col: 0 }))).toEqual({
      type: 'move',
      row: 0,
      col: 1,
    });
  });

  it('Tab は行をまたぐ', () => {
    expect(resolveGridNav(ctx({ key: 'Tab', row: 0, col: 2 }))).toEqual({
      type: 'move',
      row: 1,
      col: 0,
    });
  });

  it('最終セルで Tab を押すと行を追加する', () => {
    expect(resolveGridNav(ctx({ key: 'Tab', row: 2, col: 2 }))).toEqual({ type: 'append', col: 0 });
  });

  it('先頭セルで Shift+Tab は何もしない（ブラウザ既定に任せる）', () => {
    expect(resolveGridNav(ctx({ key: 'Tab', shiftKey: true, row: 0, col: 0 }))).toEqual({
      type: 'none',
    });
  });

  it('Enter は同じ列の下の行へ', () => {
    expect(resolveGridNav(ctx({ key: 'Enter', row: 0, col: 2 }))).toEqual({
      type: 'move',
      row: 1,
      col: 2,
    });
  });

  it('最終行の Enter は同じ列で行を追加する', () => {
    expect(resolveGridNav(ctx({ key: 'Enter', row: 2, col: 1 }))).toEqual({
      type: 'append',
      col: 1,
    });
  });

  it('→ はキャレットが末尾のときだけ右の列へ', () => {
    expect(resolveGridNav(ctx({ key: 'ArrowRight', col: 0, atEnd: true }))).toEqual({
      type: 'move',
      row: 0,
      col: 1,
    });
    expect(resolveGridNav(ctx({ key: 'ArrowRight', col: 0, atEnd: false }))).toEqual({
      type: 'none',
    });
  });

  it('← はキャレットが先頭のときだけ左の列へ', () => {
    expect(resolveGridNav(ctx({ key: 'ArrowLeft', col: 1, atStart: true }))).toEqual({
      type: 'move',
      row: 0,
      col: 0,
    });
    expect(resolveGridNav(ctx({ key: 'ArrowLeft', col: 0, atStart: true }))).toEqual({
      type: 'none',
    });
  });

  it('最終行で ↓ は何もしない', () => {
    expect(resolveGridNav(ctx({ key: 'ArrowDown', row: 2 }))).toEqual({ type: 'none' });
  });

  it('↑ は同じ列の上の行へ', () => {
    expect(resolveGridNav(ctx({ key: 'ArrowUp', row: 2, col: 1 }))).toEqual({
      type: 'move',
      row: 1,
      col: 1,
    });
  });

  it('先頭行で ↑ は何もしない', () => {
    expect(resolveGridNav(ctx({ key: 'ArrowUp', row: 0 }))).toEqual({ type: 'none' });
  });
});

describe('resolveGridNav（カード表示）', () => {
  it('↓ は直列に次のセルへ進む', () => {
    expect(resolveGridNav(ctx({ key: 'ArrowDown', cards: true, row: 0, col: 2 }))).toEqual({
      type: 'move',
      row: 1,
      col: 0,
    });
  });

  it('← → は使わない', () => {
    expect(resolveGridNav(ctx({ key: 'ArrowRight', cards: true, atEnd: true }))).toEqual({
      type: 'none',
    });
  });

  it('Tab は直列に次のセルへ進む', () => {
    expect(resolveGridNav(ctx({ key: 'Tab', cards: true, row: 1, col: 0 }))).toEqual({
      type: 'move',
      row: 1,
      col: 1,
    });
  });

  it('Shift+Tab は直列に戻る', () => {
    expect(
      resolveGridNav(ctx({ key: 'Tab', shiftKey: true, cards: true, row: 1, col: 0 })),
    ).toEqual({ type: 'move', row: 0, col: 2 });
  });

  it('↑ は直列に前のセルへ戻る', () => {
    expect(resolveGridNav(ctx({ key: 'ArrowUp', cards: true, row: 1, col: 0 }))).toEqual({
      type: 'move',
      row: 0,
      col: 2,
    });
  });

  it('先頭セルで ↑ は何もしない', () => {
    expect(resolveGridNav(ctx({ key: 'ArrowUp', cards: true, row: 0, col: 0 }))).toEqual({
      type: 'none',
    });
  });

  it('最後のセルで ↓ は何もしない（行は追加しない）', () => {
    expect(resolveGridNav(ctx({ key: 'ArrowDown', cards: true, row: 2, col: 2 }))).toEqual({
      type: 'none',
    });
  });

  it('最後のセルで Enter は行を追加する', () => {
    expect(resolveGridNav(ctx({ key: 'Enter', cards: true, row: 2, col: 2 }))).toEqual({
      type: 'append',
      col: 0,
    });
  });
});

it('対象外のキーは何もしない', () => {
  expect(resolveGridNav(ctx({ key: 'a' }))).toEqual({ type: 'none' });
});
