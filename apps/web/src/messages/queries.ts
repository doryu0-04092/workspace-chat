import type { components } from '@workspace-chat/shared';
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { requestJson } from '../api/client';
import { useSessionStore } from '../auth/session-context';

type Schemas = components['schemas'];
export type Message = Schemas['Message'];
type MessagePage = Schemas['MessagePage'];
type Pages = InfiniteData<MessagePage, string | null>;

function messagesKey(workspaceId: string, channelId: string) {
  return ['workspaces', workspaceId, 'channels', channelId, 'messages'] as const;
}

function messagesPath(workspaceId: string, channelId: string): string {
  return `/api/workspaces/${workspaceId}/channels/${channelId}/messages`;
}

/**
 * チャンネルのメッセージ（F-11・F-12。REST の仕様の listMessages）。
 * 1ページ目が最新で、続きは `nextBefore` を `before` に渡して古い側へ遡る（カーソルページネーション。機能一覧 4.1）。
 */
export function useMessages(workspaceId: string, channelId: string) {
  const store = useSessionStore();
  return useInfiniteQuery({
    queryKey: messagesKey(workspaceId, channelId),
    queryFn: ({ pageParam }) =>
      requestJson<MessagePage>(
        store,
        pageParam === null
          ? messagesPath(workspaceId, channelId)
          : `${messagesPath(workspaceId, channelId)}?${new URLSearchParams({ before: pageParam })}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore,
  });
}

/** 投稿する（REST の仕様の postMessage）。応答のメッセージを最新のページの先頭に足し、一覧は読み直さない。 */
export function usePostMessage(workspaceId: string, channelId: string) {
  const store = useSessionStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      requestJson<Message>(store, messagesPath(workspaceId, channelId), {
        method: 'POST',
        body: { body } satisfies Schemas['PostMessageRequest'],
      }),
    onSuccess: (message) =>
      queryClient.setQueryData<Pages>(messagesKey(workspaceId, channelId), (data) => {
        const [newest, ...older] = data?.pages ?? [];
        if (!data || !newest) return data;
        return {
          ...data,
          pages: [{ ...newest, messages: [message, ...newest.messages] }, ...older],
        };
      }),
  });
}
