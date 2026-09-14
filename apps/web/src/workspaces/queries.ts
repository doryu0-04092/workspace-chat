import type { components } from '@workspace-chat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { requestJson, segment } from '../api/client';
import { useSessionStore } from '../auth/session-context';

type Schemas = components['schemas'];
export type Workspace = Schemas['Workspace'];
export type Channel = Schemas['Channel'];

const keys = {
  workspaces: ['workspaces'] as const,
  workspace: (workspaceId: string) => ['workspaces', workspaceId] as const,
  channels: (workspaceId: string) => ['workspaces', workspaceId, 'channels'] as const,
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
