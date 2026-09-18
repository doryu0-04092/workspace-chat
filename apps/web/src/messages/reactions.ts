import type { components } from '@workspace-chat/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { requestJson, segment } from '../api/client';
import { useSessionStore } from '../auth/session-context';
import { type MessagePages, messagesKey, replaceReactions } from './queries';

type MessageReactions = components['schemas']['MessageReactions'];

/**
 * 「リアクションを付ける」で選べる絵文字（F-18。機能一覧 7）。**絵文字の供給元はここだけに置く**（要件定義書 6.5「後から差し替えられるよう、絵文字の供給元を1箇所に閉じた実装とする」）。
 * **Unicode の絵文字を端末の文字で描く**——画像の絵文字セット（Twemoji など）を依存に足さないため、6.5 のライセンスの確認が要る配布物を持たない。
 * 代償: 端末によって見た目が違い、古い端末では描けない絵文字がある。api は絵文字1つなら何でも受け付ける（ここに無い絵文字も、他の人が付けたものを押せば付く）。
 */
export const REACTION_EMOJIS = ['👍', '❤️', '😂', '🎉', '👀', '🙏'] as const;

/**
 * リアクションを付ける・外す（F-18。REST の仕様の addReaction / removeReaction。判定は api）。
 * 通ったら、応答のリアクションの全体を、`messagesKey` の前方一致で、チャンネルの一覧と読み込んである全ての返信のキャッシュに当てる
 * （`reaction:changed` の配信と同じ当て方。配信は親を持たないため、返信がどのスレッドにあるかを問わず当てる）。
 */
export function useToggleReaction(workspaceId: string, channelId: string) {
  const store = useSessionStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, emoji, add }: { messageId: string; emoji: string; add: boolean }) =>
      requestJson<MessageReactions>(
        store,
        `/api/workspaces/${segment(workspaceId)}/channels/${segment(channelId)}/messages/${segment(messageId)}/reactions/${segment(emoji)}`,
        { method: add ? 'PUT' : 'DELETE' },
      ),
    onSuccess: (result) =>
      queryClient.setQueriesData<MessagePages>(
        { queryKey: messagesKey(workspaceId, channelId) },
        (data) => replaceReactions(data, result),
      ),
  });
}
