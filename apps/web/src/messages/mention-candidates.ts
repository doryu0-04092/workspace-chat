import { useQuery } from '@tanstack/react-query';
import type { components } from '@workspace-chat/shared';
import { requestJson, segment } from '../api/client';
import { useSessionStore } from '../auth/session-context';

export type UserSummary = components['schemas']['UserSummary'];

/**
 * メンションの補完候補（F-20。REST の仕様の listMentionCandidates）。**`prefix` が null の間は読まない**（書きかけのメンションが無い）。
 * 同じ `prefix` はキャッシュを使う。
 */
export function useMentionCandidates(
  workspaceId: string,
  channelId: string,
  prefix: string | null,
) {
  const store = useSessionStore();
  return useQuery({
    queryKey: ['workspaces', workspaceId, 'channels', channelId, 'mention-candidates', prefix],
    queryFn: () =>
      requestJson<UserSummary[]>(
        store,
        `/api/workspaces/${segment(workspaceId)}/channels/${segment(channelId)}/mention-candidates?${new URLSearchParams({ prefix: prefix ?? '' })}`,
      ),
    enabled: prefix !== null,
  });
}
