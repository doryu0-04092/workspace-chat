import type { components } from '@workspace-chat/shared';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { requestJson, segment } from '../api/client';
import { useSessionStore } from '../auth/session-context';

type Schemas = components['schemas'];
export type Notification = Schemas['Notification'];
type NotificationPage = Schemas['NotificationPage'];

export const notificationsKey = ['users', 'me', 'notifications'] as const;

const NOTIFICATIONS_PATH = '/api/users/me/notifications';

/**
 * 自分の通知（F-26。REST の仕様の listMyNotifications）。新しい順のページを遡って読む（1ページ目が最新、続きは `nextBefore` を `before` に渡す）。
 * **本人の通知で、いまそのチャンネルの参加者であるものだけが返る**——絞るのは api である（CLAUDE.md 2）。
 */
export function useNotifications() {
  const store = useSessionStore();
  return useInfiniteQuery({
    queryKey: notificationsKey,
    queryFn: ({ pageParam }) =>
      requestJson<NotificationPage>(
        store,
        pageParam === null
          ? NOTIFICATIONS_PATH
          : `${NOTIFICATIONS_PATH}?${new URLSearchParams({ before: pageParam })}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore,
  });
}

/**
 * 通知を既読にする（F-26。REST の仕様の markNotificationRead）。通ったら一覧を読み直す（既読にした時刻は api が持つ）。
 */
export function useMarkNotificationRead() {
  const store = useSessionStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (notificationId: string) =>
      requestJson<void>(store, `${NOTIFICATIONS_PATH}/${segment(notificationId)}/read`, {
        method: 'PUT',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: notificationsKey }),
  });
}
