import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import type { components } from '@workspace-chat/shared';
import { createContext, useEffect } from 'react';
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

/**
 * 開いている会話の添付の Cookie の最初の発行が終わったか（#661）。会話の画面が値を渡し、添付の表示が読む。
 * **終わる前に `<img>` を出すと、前の会話の Cookie で取りに行って 403 になり、Cookie が届いても取り直さない。**
 * 会話の画面の外の既定は true（待つものが無い）。
 */
export const FileCookiesReady = createContext(true);

/** いま開いている会話（チャンネル・DM）の Cookie の発行の経路。 */
const openConversations = new WeakMap<QueryClient, { path: string }>();

const filesKey = (cookiesPath: string) => ['delivery', 'files', cookiesPath] as const;

/**
 * チャンネルを開いている間、そのチャンネルの `/files/workspace/{ws}/channel/{ch}/*` の Cookie を取り直す。
 *
 * **添付の Cookie は名前と Path（`/files`）が同じで、別のチャンネル・DM で発行すると上書きされる。** そのため:
 * - 閉じたら記憶を残さない（`gcTime: 0`）——開き直したときに、まだ新しいとみなして発行し直さない、を起こさない
 * - 前の会話の発行が、移った先の発行より後に返ったら、いま開いている会話の分を発行し直す（前の Cookie が残るため）
 *
 * 返すのは、最初の発行が終わったか（通っても断られても true。`FileCookiesReady` に渡す）。
 */
export function useChannelFileCookies(workspaceId: string, channelId: string): boolean {
  return useConversationFileCookies(
    `/api/workspaces/${segment(workspaceId)}/channels/${segment(channelId)}/files/cookies`,
  );
}

/** DM を開いている間、その DM の `/files/workspace/{ws}/dm/{dmId}/*` の Cookie を取り直す（#239。扱いはチャンネルと同じ）。 */
export function useDmFileCookies(workspaceId: string, dmId: string): boolean {
  return useConversationFileCookies(
    `/api/workspaces/${segment(workspaceId)}/dms/${segment(dmId)}/files/cookies`,
  );
}

function useConversationFileCookies(cookiesPath: string): boolean {
  const store = useSessionStore();
  const queryClient = useQueryClient();

  useEffect(() => {
    const conversation = { path: cookiesPath };
    openConversations.set(queryClient, conversation);
    return () => {
      if (openConversations.get(queryClient) === conversation)
        openConversations.delete(queryClient);
    };
  }, [queryClient, cookiesPath]);

  const cookies = useQuery({
    queryKey: filesKey(cookiesPath),
    queryFn: async () => {
      const result = await issue(store, cookiesPath);
      const open = openConversations.get(queryClient);
      if (open && open.path !== cookiesPath) {
        void queryClient.refetchQueries({ queryKey: filesKey(open.path), exact: true });
      }
      return result;
    },
    gcTime: 0,
    ...refreshOptions,
  });
  // 取り直し（期限の前・移った先の発行し直し）の間は false に戻さない——戻すと、表示中の画像を外して付け直すことになる
  return !cookies.isPending;
}
