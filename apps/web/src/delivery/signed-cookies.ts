import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import type { components } from '@workspace-chat/shared';
import { useEffect } from 'react';
import { requestJson, segment } from '../api/client';
import { useSessionStore } from '../auth/session-context';

type SignedCookiesResponse = components['schemas']['SignedCookiesResponse'];

/**
 * CloudFront の署名付き Cookie（アバター F-04・添付 F-29。機能一覧 1.3・11.2）を、期限より前に api に発行し直してもらう。
 * Cookie そのものはブラウザが Set-Cookie で持つ（HttpOnly）。画面が持つのは、いつ取り直すかだけである。
 * **発行されなかった（204。署名鍵を設定していない手元）なら取り直さない。**
 */

/** 有効期間のうち、この割合が過ぎたら取り直す（残り 1/3 を、裏のタブのタイマーの遅れと通信の失敗のやり直しに充てる）。 */
const REFRESH_RATIO = 2 / 3;
/** 取り直しの間隔の下限（有効期間が極端に短い応答で、要求を詰めて送らない）。 */
const MIN_REFRESH_MS = 1000;

/** 発行した応答なら取り直すまでのミリ秒、発行しなかった（null）なら false。 */
function refreshAfter(data: SignedCookiesResponse | null | undefined): number | false {
  if (!data) return false;
  return Math.max(MIN_REFRESH_MS, Math.floor(data.expiresIn * 1000 * REFRESH_RATIO));
}

type CookiesQuery = { state: { data: SignedCookiesResponse | null | undefined } };

/**
 * 取り直しの間隔と、その間は新しいとみなす時間（画面に戻ったとき・通信が戻ったときに、間隔より前なら取り直さない）を揃える。
 * 発行しなかった（null）なら取り直さない。まだ一度も発行できていない（失敗した）なら、画面に戻ったとき・通信が戻ったときに取り直す
 * （値の無い問い合わせは、staleTime によらず古いとみなされる——TanStack Query v5 の isStaleByTime）。
 */
const refreshOptions = {
  refetchInterval: (query: CookiesQuery) => refreshAfter(query.state.data),
  refetchIntervalInBackground: true,
  staleTime: (query: CookiesQuery) => refreshAfter(query.state.data) || Infinity,
} as const;

/** 204 は null にする（問い合わせの値に undefined を置けない）。 */
async function issue(
  store: ReturnType<typeof useSessionStore>,
  path: string,
): Promise<SignedCookiesResponse | null> {
  return (
    (await requestJson<SignedCookiesResponse | undefined>(store, path, { method: 'POST' })) ?? null
  );
}

/** ログインしている間、`/avatars/*` の Cookie を取り直す（ログインした画面の枠が呼ぶ）。 */
export function useAvatarCookies(): void {
  const store = useSessionStore();
  useQuery({
    queryKey: ['delivery', 'avatars'],
    queryFn: () => issue(store, '/api/avatars/cookies'),
    ...refreshOptions,
  });
}

/** いま添付の Cookie を取り直しているチャンネル（読み込みの記憶ごと。テストは記憶をテストごとに作る）。 */
const openChannels = new WeakMap<QueryClient, { workspaceId: string; channelId: string }>();

const filesKey = (workspaceId: string, channelId: string) =>
  ['delivery', 'files', workspaceId, channelId] as const;

/**
 * チャンネルを開いている間、そのチャンネルの `/files/workspace/{ws}/channel/{ch}/*` の Cookie を取り直す。
 *
 * **添付の Cookie は名前と Path（`/files`）が同じで、別のチャンネルで発行すると上書きされる。** そのため:
 * - 閉じたら記憶を残さない（`gcTime: 0`）——開き直したときに、まだ新しいとみなして発行し直さない、を起こさない
 * - 前のチャンネルの発行が、移った先の発行より後に返ったら、いま開いているチャンネルの分を発行し直す（前の Cookie が残るため）
 */
export function useChannelFileCookies(workspaceId: string, channelId: string): void {
  const store = useSessionStore();
  const queryClient = useQueryClient();

  useEffect(() => {
    const channel = { workspaceId, channelId };
    openChannels.set(queryClient, channel);
    return () => {
      if (openChannels.get(queryClient) === channel) openChannels.delete(queryClient);
    };
  }, [queryClient, workspaceId, channelId]);

  useQuery({
    queryKey: filesKey(workspaceId, channelId),
    queryFn: async () => {
      const result = await issue(
        store,
        `/api/workspaces/${segment(workspaceId)}/channels/${segment(channelId)}/files/cookies`,
      );
      const open = openChannels.get(queryClient);
      if (open && (open.workspaceId !== workspaceId || open.channelId !== channelId)) {
        void queryClient.refetchQueries({
          queryKey: filesKey(open.workspaceId, open.channelId),
          exact: true,
        });
      }
      return result;
    },
    gcTime: 0,
    ...refreshOptions,
  });
}
