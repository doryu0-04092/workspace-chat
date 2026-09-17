import type { components } from '@workspace-chat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { requestJson, segment } from '../api/client';
import { useSessionStore } from '../auth/session-context';

type PinList = components['schemas']['PinList'];
type PinnedMessage = components['schemas']['PinnedMessage'];

/**
 * チャンネルのピン留めの一覧の鍵（F-33）。**`messagesKey` の下に置かない**——メッセージのキャッシュを前方一致で書き換える処理
 * （削除の反映・`reaction:changed` など）がページの形を前提にしており、この一覧に当たると壊れる。
 */
export function pinsKey(workspaceId: string, channelId: string) {
  return ['workspaces', workspaceId, 'channels', channelId, 'pins'] as const;
}

function channelPath(workspaceId: string, channelId: string): string {
  return `/api/workspaces/${segment(workspaceId)}/channels/${segment(channelId)}`;
}

/**
 * チャンネルのピン留めの一覧（F-33。REST の仕様の listPins）。メッセージのピン留め済みの印と、一覧の画面が同じ鍵を読む。
 * **ピン留めの変化は配信されない**（要件定義書 4.1 の対象外）ため、他の人の付け外しは、読み直すまで反映されない——
 * 一覧を開いたときに読み直す（既定の `staleTime` 0 で、新しく読む部品が付くと取り直す）。
 */
export function usePins(workspaceId: string, channelId: string) {
  const store = useSessionStore();
  return useQuery({
    queryKey: pinsKey(workspaceId, channelId),
    queryFn: () => requestJson<PinList>(store, `${channelPath(workspaceId, channelId)}/pins`),
  });
}

/**
 * ピン留めする・外す（F-33。REST の仕様の pinMessage / unpinMessage。判定は api）。
 * 通ったら、一覧のキャッシュに足す・外す（読み直さない）。ピン留めは新しい順の先頭に足し、既にあれば足さない。
 */
export function useTogglePin(workspaceId: string, channelId: string) {
  const store = useSessionStore();
  const queryClient = useQueryClient();
  const key = pinsKey(workspaceId, channelId);
  return useMutation({
    mutationFn: async ({ messageId, pin }: { messageId: string; pin: boolean }) => {
      const path = `${channelPath(workspaceId, channelId)}/messages/${segment(messageId)}/pin`;
      if (pin) return requestJson<PinnedMessage>(store, path, { method: 'PUT' });
      await requestJson<void>(store, path, { method: 'DELETE' });
      return null;
    },
    onSuccess: (pinned, { messageId }) =>
      queryClient.setQueryData<PinList>(key, (data) => {
        const others = (data?.pins ?? []).filter((p) => p.message.id !== messageId);
        const kept = data?.pins.find((p) => p.message.id === messageId);
        if (pinned === null) return { pins: others };
        return data && kept ? data : { pins: [pinned, ...others] };
      }),
  });
}
