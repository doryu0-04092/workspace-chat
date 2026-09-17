import { skipToken, useQuery } from '@tanstack/react-query';

/**
 * 開いているチャンネルの在席（F-22。機能一覧 9.2）を置くキャッシュの鍵。値は在席している参加者の `User.id` の並び。
 * **書くのは部屋の側の経路だけ**（`use-channel-realtime.ts` の入室の acknowledgement と `presence:changed`）——
 * 参加者一覧の API は在席を返さない（9.2「在席を画面へ渡す経路は、部屋の側だけにする」）。
 */
export function presenceKey(workspaceId: string, channelId: string) {
  return ['presence', workspaceId, channelId] as const;
}

/** 在席している参加者の `User.id`。**要求を出さない**（部屋の側の経路が書いた値を読むだけ）。入室できていなければ空。 */
export function useChannelPresence(workspaceId: string, channelId: string): ReadonlySet<string> {
  const { data } = useQuery<readonly string[]>({
    queryKey: presenceKey(workspaceId, channelId),
    queryFn: skipToken,
  });
  return new Set(data ?? []);
}
