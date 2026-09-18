import { useQueryClient } from '@tanstack/react-query';
import type {
  DmMessageNewPayload,
  MessageNewPayload,
  RealtimeEventName,
} from '@workspace-chat/shared';
import { useEffect, useRef } from 'react';
import { type Location, useLocation, useNavigate } from 'react-router';
import { useSession } from '../auth/session-context';
import type { Message } from '../messages/queries';
import { useRealtime } from '../realtime/realtime-context';
import {
  broadcastNotificationOf,
  dmNotificationOf,
  mentionNotificationOf,
  showBrowserNotification,
} from './browser-notifications';
import { notificationsKey } from './queries';

const MESSAGE_NEW = 'message:new' satisfies RealtimeEventName;

/**
 * いまの画面にそのメッセージが出ているか。本体はそのチャンネルを開いているとき、返信はそのスレッドを開いているとき。
 * **タブが見えていなければ、出ていないとみなす**（別のタブを見ている間は通知する）。
 */
function onScreen(location: Location, message: Message): boolean {
  if (document.visibilityState !== 'visible') return false;
  if (!location.pathname.endsWith(`/channels/${message.channelId}`)) return false;
  return (
    message.parentId === null ||
    new URLSearchParams(location.search).get('thread') === message.parentId
  );
}

/**
 * 自分へのメンションが届いたときの反映（F-25・F-26。機能一覧 10.2・10.3）。ログインした画面の枠が1つだけ持つ。
 *
 * - **読み込んである通知の一覧を読み直す**（ブラウザ通知を有効にしているかによらない）
 * - **利用者が有効にしていて、ブラウザが許可していれば、ブラウザ通知を出す**。いまの画面にそのメッセージが出ていれば出さない。
 *   押したら通知の一覧へ移る——配信のメッセージはワークスペースの id を持たないため、チャンネルの URL を組み立てられない
 *
 * **届くのは、メンションの対象の利用者の部屋へ送られた `message:new` である**（開いていないチャンネルでも届く。機能一覧 5.2）。
 * DM（F-19）の通知は、DM の配信を受ける同じ形の処理をここに足す（中身の作り方は `browser-notifications.ts`）。
 */
export function useMentionRealtime() {
  const { socket } = useRealtime();
  const session = useSession();
  const userId = session.status === 'signedIn' ? session.user.id : null;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  // 購読し直さずに、届いた時点の画面を読む
  const locationRef = useRef(location);
  useEffect(() => {
    locationRef.current = location;
  }, [location]);

  useEffect(() => {
    if (userId === null) return;
    const onNew = (payload: MessageNewPayload | DmMessageNewPayload) => {
      // **DM の `message:new` は同じイベント名で届く**（`dmId` を持ち、`mentions` を持たない）。メンションではなく DM の通知として扱う（#623）
      if ('dmId' in payload.message) {
        const dm = payload.message;
        const dmContent = dmNotificationOf(dm, { id: userId });
        if (dmContent === null) return;
        void queryClient.invalidateQueries({ queryKey: notificationsKey });
        // いまその DM を開いて見ていれば出さない
        if (
          document.visibilityState === 'visible' &&
          locationRef.current.pathname.endsWith(`/dms/${dm.dmId}`)
        ) {
          return;
        }
        showBrowserNotification(userId, dmContent, () => navigate('/notifications'));
        return;
      }
      const { message } = payload;
      // 個人のメンション、なければ一斉メンション（@channel・開いているチャンネルの @here。機能一覧 9.2・10.2）
      const content =
        mentionNotificationOf(message, { id: userId }) ??
        broadcastNotificationOf(
          message,
          { id: userId },
          { hereOpen: locationRef.current.pathname.endsWith(`/channels/${message.channelId}`) },
        );
      if (content === null) return;
      void queryClient.invalidateQueries({ queryKey: notificationsKey });
      if (onScreen(locationRef.current, message)) return;
      showBrowserNotification(userId, content, () => navigate('/notifications'));
    };
    socket.on(MESSAGE_NEW, onNew);
    return () => {
      socket.off(MESSAGE_NEW, onNew);
    };
  }, [socket, userId, queryClient, navigate]);
}
