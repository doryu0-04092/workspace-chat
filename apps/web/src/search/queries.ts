import type { components } from '@workspace-chat/shared';
import { useQuery } from '@tanstack/react-query';
import { requestJson, segment } from '../api/client';
import { useSessionStore } from '../auth/session-context';

export type SearchResult = components['schemas']['SearchResult'];

/** 検索の文字列が送れる形か（空白だけは送らない。api も 400 で断る）。 */
export function isSearchable(q: string): boolean {
  return q.trim() !== '';
}

/**
 * 検索（F-30。REST の仕様の search。機能一覧 12.1）。空白だけの文字列では読まない。
 * **画面を離れたら結果を記憶に残さない**（`gcTime: 0`）——結果はプライベートチャンネルの本文を含みうる。
 * 残すと、チャンネルを抜けた・外された後に同じ検索の画面を開いたとき、取り直しが終わるまで読めなくなった本文が出る。
 */
export function useSearch(workspaceId: string, q: string) {
  const store = useSessionStore();
  return useQuery({
    queryKey: ['workspaces', workspaceId, 'search', q] as const,
    queryFn: () =>
      requestJson<SearchResult>(
        store,
        `/api/workspaces/${segment(workspaceId)}/search?q=${encodeURIComponent(q)}`,
      ),
    enabled: isSearchable(q),
    gcTime: 0,
  });
}
