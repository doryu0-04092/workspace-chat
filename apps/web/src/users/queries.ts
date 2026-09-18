import type { components } from '@workspace-chat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { requestJson, segment } from '../api/client';
import { useSessionStore } from '../auth/session-context';
import type { SessionStore } from '../auth/session-store';
import { uploadFile } from '../file-uploads/upload-file';

type Schemas = components['schemas'];
export type UserSettings = Schemas['UserSettings'];
export type Profile = Schemas['Profile'];

export const settingsKey = ['users', 'me', 'settings'] as const;

const profileKey = ['users', 'me', 'profile'] as const;

const PROFILE_PATH = '/api/users/me';

/** いまログインしている利用者の id。ログインしていなければ null。 */
function signedInUserId(store: SessionStore): string | null {
  const state = store.getState();
  return state.status === 'signedIn' ? state.user.id : null;
}

/** 自分のプロフィール（F-04。REST の仕様の getMyProfile）。ステータスはログインの状態に持たないため、編集の画面で読む。 */
export function useMyProfile() {
  const store = useSessionStore();
  return useQuery({
    queryKey: profileKey,
    queryFn: () => requestJson<Profile>(store, PROFILE_PATH),
  });
}

/**
 * プロフィールを変える（F-04。REST の仕様の updateMyProfile）。通ったら、応答で読み込んだプロフィールを置き換え、
 * **画面の枠の表示名に使うログインの状態の利用者の情報も、読み直さずに差し替える**。
 *
 * **踏むと壊れる: 応答の利用者が、いまログインしている利用者でなければ何も書かない。** 読み込みの鍵は利用者を含まない（App.tsx）ため、
 * 応答を待つ間にログアウトして別の利用者がログインしていると、前の利用者のプロフィールが次の利用者の記憶に入る（#558 第0巡の 🔴1）。
 */
export function useUpdateProfile() {
  const store = useSessionStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas['UpdateProfileRequest']) =>
      requestJson<Profile>(store, PROFILE_PATH, { method: 'PATCH', body }),
    onSuccess: (profile) => {
      if (signedInUserId(store) !== profile.id) return;
      queryClient.setQueryData<Profile>(profileKey, profile);
      store.updateUser({
        id: profile.id,
        userId: profile.userId,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
      });
    },
  });
}

/**
 * 自分のアカウントを削除する（F-36。REST の仕様の deleteMyAccount）。削除できたら、ログインしていない状態にする
 * （読み込みの記憶は App.tsx がログインの状態の切り替えで捨てる）。
 *
 * **踏むと壊れる: 送った時点の利用者がいまもログインしているときだけ切り替える**（応答は利用者の id を持たないため、送った時点で控える。
 * 待つ間に別の利用者がログインしていたら、その利用者をログアウトさせない。プロフィールの保存と同じ理由）。
 */
export function useDeleteAccount() {
  const store = useSessionStore();
  return useMutation({
    mutationFn: (body: Schemas['DeleteAccountRequest']) =>
      requestJson<void>(store, '/api/users/me/delete', { method: 'POST', body }),
    onMutate: () => ({ userId: signedInUserId(store) }),
    onSuccess: (_, __, sent) => {
      if (sent.userId !== null) store.endDeletedAccount(sent.userId);
    },
  });
}

const AVATAR_UPLOADS_PATH = '/api/users/me/avatar/uploads';

/**
 * アバター画像を上げる（F-04。機能一覧 1.3）: 発行 → 署名付き URL への PUT → 確定。通ったら、確定の応答（プロフィール）で読み込んだプロフィールを置き換える
 * （プロフィールの画面と画面の枠が同じ読み込みを使うため、どちらも読み直さずに変わる）。**画像だけを送る。**
 *
 * **踏むと壊れる: 応答の利用者が、いまログインしている利用者でなければ何も書かない**（`useUpdateProfile` と同じ理由。#558 第0巡の 🔴1）。
 */
export function useUploadAvatar() {
  const store = useSessionStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: File) =>
      uploadFile<Profile>(store, file, {
        issuePath: AVATAR_UPLOADS_PATH,
        completePath: (uploadId) => `${AVATAR_UPLOADS_PATH}/${segment(uploadId)}/complete`,
        kinds: ['image'],
      }),
    onSuccess: (profile) => {
      if (signedInUserId(store) !== profile.id) return;
      queryClient.setQueryData<Profile>(profileKey, profile);
    },
  });
}

const SETTINGS_PATH = '/api/users/me/settings';

/** 利用者ごとの設定（F-23。REST の仕様の getMySettings）。**プロフィールとは別の経路である**（機能一覧 10.1）。 */
export function useUserSettings() {
  const store = useSessionStore();
  return useQuery({
    queryKey: settingsKey,
    queryFn: () => requestJson<UserSettings>(store, SETTINGS_PATH),
  });
}

/**
 * 設定を変える（F-23。REST の仕様の updateMySettings）。
 * **変えたら、読み込んであるチャンネルの一覧を取り直す**——スレッドの未読を含めるかは未読数の意味を変えるため。
 * **既読位置は動かさない**（一括で既読扱いにしない。要件定義書 3.5.2）。
 *
 * **踏むと壊れる: 送った時点の利用者が、応答が届いた時点でもログインしていなければ何も書かない**（応答は利用者の id を持たないため、送った時点で控える。
 * プロフィールの保存と同じ理由。#558 第0巡の 🔴1）。
 */
export function useUpdateUserSettings() {
  const store = useSessionStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas['UpdateUserSettingsRequest']) =>
      requestJson<UserSettings>(store, SETTINGS_PATH, { method: 'PATCH', body }),
    onMutate: () => ({ userId: signedInUserId(store) }),
    onSuccess: (settings, _, sent) => {
      if (sent.userId === null || sent.userId !== signedInUserId(store)) return;
      queryClient.setQueryData<UserSettings>(settingsKey, settings);
      void queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === 'workspaces' && query.queryKey[2] === 'channels',
      });
    },
  });
}
