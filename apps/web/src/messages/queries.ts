import type { components } from '@workspace-chat/shared';
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { requestJson, segment } from '../api/client';
import { useSessionStore } from '../auth/session-context';

type Schemas = components['schemas'];
export type Message = Schemas['Message'];
type MessagePage = Schemas['MessagePage'];
export type MessagePages = InfiniteData<MessagePage, string | null>;

export function messagesKey(workspaceId: string, channelId: string) {
  return ['workspaces', workspaceId, 'channels', channelId, 'messages'] as const;
}

/** 最新のページの先頭（画面の最後）に足す。同じ id が既にあれば足さない（投稿の応答と配信のどちらが先に届いても1行にする）。 */
export function addMessage(
  data: MessagePages | undefined,
  message: Message,
): MessagePages | undefined {
  const [newest, ...older] = data?.pages ?? [];
  if (!data || !newest) return data;
  if (data.pages.some((page) => page.messages.some((m) => m.id === message.id))) return data;
  return {
    ...data,
    pages: [{ ...newest, messages: [message, ...newest.messages] }, ...older],
  };
}

/** 同じ id のメッセージを置き換える（編集。機能一覧 4.2）。 */
export function replaceMessage(
  data: MessagePages | undefined,
  message: Message,
): MessagePages | undefined {
  return mapMessages(data, (m) => (m.id === message.id ? message : m));
}

/** 削除済みにする（本文を持たない。機能一覧 4.2）。 */
export function markDeleted(
  data: MessagePages | undefined,
  messageId: string,
): MessagePages | undefined {
  return mapMessages(data, (m) => (m.id === messageId ? { ...m, body: null, deleted: true } : m));
}

function mapMessages(
  data: MessagePages | undefined,
  change: (message: Message) => Message,
): MessagePages | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({ ...page, messages: page.messages.map(change) })),
  };
}

function messagesPath(workspaceId: string, channelId: string): string {
  return `/api/workspaces/${segment(workspaceId)}/channels/${segment(channelId)}/messages`;
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
      queryClient.setQueryData<MessagePages>(messagesKey(workspaceId, channelId), (data) =>
        addMessage(data, message),
      ),
  });
}
