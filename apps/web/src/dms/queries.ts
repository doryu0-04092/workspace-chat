import type { components } from '@workspace-chat/shared';
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { requestJson, segment } from '../api/client';
import { useSessionStore } from '../auth/session-context';
import { addMessage, markDeleted, replaceMessage } from '../messages/queries';

type Schemas = components['schemas'];
export type Dm = Schemas['Dm'];
export type DmMessage = Schemas['DmMessage'];
type DmMessagePage = Schemas['DmMessagePage'];
export type DmMessagePages = InfiniteData<DmMessagePage, string | null>;

/**
 * 自分が当事者の DM の一覧の鍵（F-19）。未読の配信の反映（use-unread-realtime）が同じ鍵を書き換える。
 * **踏むと壊れる: DM のメッセージの鍵（`dmMessagesKey`）はこの鍵の下にある**——一覧だけを取り直すときは `exact` で当てる。
 */
export function dmsKey(workspaceId: string) {
  return ['workspaces', workspaceId, 'dms'] as const;
}

export function dmMessagesKey(workspaceId: string, dmId: string) {
  return [...dmsKey(workspaceId), dmId, 'messages'] as const;
}

function dmsPath(workspaceId: string): string {
  return `/api/workspaces/${segment(workspaceId)}/dms`;
}

function dmMessagesPath(workspaceId: string, dmId: string): string {
  return `${dmsPath(workspaceId)}/${segment(dmId)}/messages`;
}

/** 自分が当事者の DM（新しいメッセージのある順。REST の仕様の listDms）。 */
export function useDms(workspaceId: string) {
  const store = useSessionStore();
  return useQuery({
    queryKey: dmsKey(workspaceId),
    queryFn: () => requestJson<Dm[]>(store, dmsPath(workspaceId)),
  });
}

/**
 * DM を始める・開く（REST の仕様の startDm。同じ相手とは1つに集約され、既にあればそれが返る）。
 * 通ったら、一覧にその DM を置く（既にあれば置き換え、無ければ先頭に足す）。一覧は読み直さない。
 */
export function useStartDm(workspaceId: string) {
  const store = useSessionStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      requestJson<Dm>(store, dmsPath(workspaceId), {
        method: 'POST',
        body: { userId } satisfies Schemas['StartDmRequest'],
      }),
    onSuccess: (dm) =>
      queryClient.setQueryData<Dm[]>(dmsKey(workspaceId), (dms) =>
        dms?.some((current) => current.id === dm.id)
          ? dms.map((current) => (current.id === dm.id ? dm : current))
          : dms && [dm, ...dms],
      ),
  });
}

/** DM のメッセージ（新しい順のページを遡って読む。REST の仕様の listDmMessages。チャンネルの一覧と同じ読み方）。 */
export function useDmMessages(workspaceId: string, dmId: string) {
  const store = useSessionStore();
  const path = dmMessagesPath(workspaceId, dmId);
  return useInfiniteQuery({
    queryKey: dmMessagesKey(workspaceId, dmId),
    queryFn: ({ pageParam }) =>
      requestJson<DmMessagePage>(
        store,
        pageParam === null ? path : `${path}?${new URLSearchParams({ before: pageParam })}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore,
  });
}

/** 投稿する（REST の仕様の postDmMessage）。応答を最新のページの先頭に足し、一覧は読み直さない。 */
export function usePostDmMessage(workspaceId: string, dmId: string) {
  const store = useSessionStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      requestJson<DmMessage>(store, dmMessagesPath(workspaceId, dmId), {
        method: 'POST',
        body: { body } satisfies Schemas['PostMessageRequest'],
      }),
    onSuccess: (message) =>
      queryClient.setQueryData<DmMessagePages>(dmMessagesKey(workspaceId, dmId), (data) =>
        addMessage(data, message),
      ),
  });
}

/** 自分のメッセージを編集する（REST の仕様の editDmMessage。判定は api）。通ったら一覧で置き換える。 */
export function useEditDmMessage(workspaceId: string, dmId: string) {
  const store = useSessionStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, body }: { messageId: string; body: string }) =>
      requestJson<DmMessage>(store, `${dmMessagesPath(workspaceId, dmId)}/${segment(messageId)}`, {
        method: 'PATCH',
        body: { body } satisfies Schemas['PostMessageRequest'],
      }),
    onSuccess: (message) =>
      queryClient.setQueryData<DmMessagePages>(dmMessagesKey(workspaceId, dmId), (data) =>
        replaceMessage(data, message),
      ),
  });
}

/** 自分のメッセージを削除する（REST の仕様の deleteDmMessage。論理削除。判定は api）。通ったら一覧で削除済みにする。 */
export function useDeleteDmMessage(workspaceId: string, dmId: string) {
  const store = useSessionStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (messageId: string) =>
      requestJson<void>(store, `${dmMessagesPath(workspaceId, dmId)}/${segment(messageId)}`, {
        method: 'DELETE',
      }),
    onSuccess: (_, messageId) =>
      queryClient.setQueryData<DmMessagePages>(dmMessagesKey(workspaceId, dmId), (data) =>
        markDeleted(data, messageId),
      ),
  });
}

/**
 * DM の既読位置を進める（F-23。REST の仕様の updateDmRead）。**戻さないのは api が持つ不変条件である**。
 * 一覧は読み直さない——進めた後の未読数は `unread:updated` で届く。
 */
export function useUpdateDmRead(workspaceId: string, dmId: string) {
  const store = useSessionStore();
  return useMutation({
    mutationFn: (lastReadMessageId: string) =>
      requestJson<void>(store, `${dmsPath(workspaceId)}/${segment(dmId)}/read`, {
        method: 'PUT',
        body: { lastReadMessageId } satisfies Schemas['UpdateDmReadRequest'],
      }),
  });
}

/** 配信で届いた未読数を、読み込んである一覧に当てる。読み込んでいなければ何もしない（一覧を作らない）。 */
export function setDmUnread(dms: Dm[] | undefined, dmId: string, unread: number): Dm[] | undefined {
  return dms?.map((dm) => (dm.id === dmId ? { ...dm, unread } : dm));
}
