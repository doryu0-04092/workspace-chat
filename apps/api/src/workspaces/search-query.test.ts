import { describe, expect, it } from 'vitest';
import { parseSearchQuery } from './search-query';

// 機能一覧 12.1（F-30）: 絞り込み演算子 `from:@ユーザーID` / `in:#チャンネル名`。#582。
describe('検索の文字列を語と絞り込み演算子に分ける', () => {
  it('空白（全角の空白を含む）で区切った語を順に並べ、演算子が無ければ絞り込まない', () => {
    expect(parseSearchQuery('  日本語　検索  test ')).toEqual({
      terms: ['日本語', '検索', 'test'],
      from: null,
      in: null,
    });
  });

  it('from:@ と in:# を語から外し、@ と # を除いた名前を持つ', () => {
    expect(parseSearchQuery('from:@Alice_1 議事録 in:#general')).toEqual({
      terms: ['議事録'],
      from: 'Alice_1',
      in: 'general',
    });
  });

  it('同じ演算子を2回書いたら後のものを使う', () => {
    expect(parseSearchQuery('from:@a from:@b in:#x in:#y')).toEqual({
      terms: [],
      from: 'b',
      in: 'y',
    });
  });

  it.each([
    ['from:', '@ が無い'],
    ['from:alice', '@ が無い'],
    ['from:@', '名前が空'],
    ['in:general', '# が無い'],
    ['in:#', '名前が空'],
    ['xfrom:@alice', '語の途中'],
  ])('%s は演算子ではなく語として扱う（%s）', (token) => {
    expect(parseSearchQuery(token)).toEqual({ terms: [token], from: null, in: null });
  });

  it('LIKE の特殊文字はそのまま語に残す（照合の側で likequery がエスケープする）', () => {
    expect(parseSearchQuery('100% a_b \\x')).toEqual({
      terms: ['100%', 'a_b', '\\x'],
      from: null,
      in: null,
    });
  });
});
