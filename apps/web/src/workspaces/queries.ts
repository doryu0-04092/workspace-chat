import type { components } from '@workspace-chat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { requestJson, segment } from '../api/client';
import { useSessionStore } from '../auth/session-context';

type Schemas = components['schemas'];
export type Workspace = Schemas['Workspace'];
export type Channel = Schemas['Channel'];

/** 見えるチャンネルの一覧の鍵。未読の配信の反映（use-unread-realtime）が同じ鍵を書き換える。 */
export function channelsKey(workspaceId: string) {
  return ['workspaces', workspaceId, 'channels'] as const;
}

const keys = {
  workspaces: ['workspaces'] as const,
  workspace: (workspaceId: string) => ['workspaces', workspaceId] as const,
  channels: channelsKey,
};

/** 所属するワークスペース（参加した順。REST の仕様の listMyWorkspaces）。 */
export function useWorkspaces() {
  const store = useSessionStore();
  return useQuery({
    queryKey: keys.workspaces,
    queryFn: () => requestJson<Workspace[]>(store, '/api/workspaces'),
  });
}

export function useWorkspace(workspaceId: string) {
  const store = useSessionStore();
  return useQuery({
    queryKey: keys.workspace(workspaceId),
    queryFn: () => requestJson<Workspace>(store, `/api/workspaces/${segment(workspaceId)}`),
  });
}

/** 見えるチャンネル（パブリックと参加しているプライベート。名前の順。REST の仕様の listChannels）。 */
export function useChannels(workspaceId: string) {
  const store = useSessionStore();
  return useQuery({
    queryKey: keys.channels(workspaceId),
    queryFn: () =>
      requestJson<Channel[]>(store, `/api/workspaces/${segment(workspaceId)}/channels`),
  });
}

export function useCreateWorkspace() {
  const store = useSessionStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas['CreateWorkspaceRequest']) =>
      requestJson<Workspace>(store, '/api/workspaces', { method: 'POST', body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.workspaces, exact: true }),
  });
}

export function useJoinChannel(workspaceId: string) {
  const store = useSessionStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) =>
      requestJson<void>(
        store,
        `/api/workspaces/${segment(workspaceId)}/channels/${segment(channelId)}/join`,
        {
          method: 'POST',
        },
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.channels(workspaceId) }),
  });
}

/**
 * 既読位置を進める（F-23。REST の仕様の updateChannelRead）。
 * **戻さないのは api が持つ不変条件である**（渡した位置が今より古ければ何もしない。機能一覧 10.1）。
 * 一覧は読み直さない——進めた後の未読数は `unread:updated` で届く。
 */
export function useUpdateChannelRead(workspaceId: string, channelId: string) {
  const store = useSessionStore();
  return useMutation({
    mutationFn: (lastReadMessageId: string) =>
      requestJson<void>(
        store,
        `/api/workspaces/${segment(workspaceId)}/channels/${segment(channelId)}/read`,
        {
          method: 'PUT',
          body: { lastReadMessageId } satisfies Schemas['UpdateChannelReadRequest'],
        },
      ),
  });
}

/** 配信で届いた未読数を、読み込んである一覧に当てる。読み込んでいなければ何もしない（一覧を作らない）。 */
export function setChannelUnread(
  channels: Channel[] | undefined,
  channelId: string,
  unread: number,
): Channel[] | undefined {
  return channels?.map((channel) => (channel.id === channelId ? { ...channel, unread } : channel));
}

export function useCreateChannel(workspaceId: string) {
  const store = useSessionStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas['CreateChannelRequest']) =>
      requestJson<Channel>(store, `/api/workspaces/${segment(workspaceId)}/channels`, {
        method: 'POST',
        body,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.channels(workspaceId) }),
  });
}
