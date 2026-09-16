import { useQueryClient } from '@tanstack/react-query';
import type { RealtimeEventName } from '@workspace-chat/shared';
import { useEffect } from 'react';
import { invitationsKey } from '../workspaces/queries';
import { useRealtime } from './realtime-context';

const INVITATION_NEW = 'invitation:new' satisfies RealtimeEventName;

/**
 * 招待の到着のリアルタイムの反映（F-38。機能一覧 2.2・5.2）。**届いたら、自分宛ての招待の一覧を取り直す。**
 *
 * **payload を一覧に当てない**——payload は `invitationId`・`sentAt`、一覧の項目は `id`・`createdAt` で形が違い、
 * 当てると送信時刻を招待の作成時刻と読み替えることになる。招待は頻度が低く、取り直しの負荷は問題にならない（#532）。
 */
export function useInvitationRealtime() {
  const { socket } = useRealtime();
  const queryClient = useQueryClient();

  useEffect(() => {
    const onInvitation = () => {
      void queryClient.invalidateQueries({ queryKey: invitationsKey });
    };
    socket.on(INVITATION_NEW, onInvitation);
    return () => {
      socket.off(INVITATION_NEW, onInvitation);
    };
  }, [socket, queryClient]);
}
