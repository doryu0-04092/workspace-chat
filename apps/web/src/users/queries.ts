import type { components } from '@workspace-chat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { requestJson } from '../api/client';
import { useSessionStore } from '../auth/session-context';

type Schemas = components['schemas'];
export type UserSettings = Schemas['UserSettings'];
export type Profile = Schemas['Profile'];

export const settingsKey = ['users', 'me', 'settings'] as const;

const profileKey = ['users', 'me', 'profile'] as const;

const PROFILE_PATH = '/api/users/me';

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
 */
export function useUpdateProfile() {
  const store = useSessionStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas['UpdateProfileRequest']) =>
      requestJson<Profile>(store, PROFILE_PATH, { method: 'PATCH', body }),
    onSuccess: (profile) => {
      queryClient.setQueryData<Profile>(profileKey, profile);
      store.updateUser({
        id: profile.id,
        userId: profile.userId,
        displayName: profile.displayName,
      });
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
 */
export function useUpdateUserSettings() {
  const store = useSessionStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas['UpdateUserSettingsRequest']) =>
      requestJson<UserSettings>(store, SETTINGS_PATH, { method: 'PATCH', body }),
    onSuccess: (settings) => {
      queryClient.setQueryData<UserSettings>(settingsKey, settings);
      void queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === 'workspaces' && query.queryKey[2] === 'channels',
      });
    },
  });
}
