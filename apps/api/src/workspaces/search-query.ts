/** 検索の文字列を分けたもの（機能一覧 12.1）。 */
export type SearchQuery = {
  /** 照合する語（空白で区切った順）。**すべてを含むものに当たる。** LIKE の特殊文字はそのまま持つ（照合の側で `likequery` がエスケープする） */
  readonly terms: string[];
  /** `from:@ユーザーID` の `@` より後。無ければ null */
  readonly from: string | null;
  /** `in:#チャンネル名` の `#` より後。無ければ null */
  readonly in: string | null;
};

const FROM = /^from:@(.+)$/u;
const IN = /^in:#(.+)$/u;

/**
 * 検索の文字列を、語と絞り込み演算子（`from:@ユーザーID` / `in:#チャンネル名`）に分ける（機能一覧 12.1）。
 * 区切りは空白（全角の空白を含む）。**演算子の形に当たらない語は、語として照合する**（`from:alice` など）。
 * 同じ演算子を2回書いたら後のものを使う。**空白を含むチャンネル名は `in:#` で指せない**（区切りと区別できない）。
 */
export function parseSearchQuery(q: string): SearchQuery {
  const terms: string[] = [];
  let from: string | null = null;
  let channel: string | null = null;
  for (const token of q.split(/\s+/u).filter((part) => part.length > 0)) {
    const author = FROM.exec(token);
    const within = IN.exec(token);
    if (author?.[1] !== undefined) from = author[1];
    else if (within?.[1] !== undefined) channel = within[1];
    else terms.push(token);
  }
  return { terms, from, in: channel };
}
