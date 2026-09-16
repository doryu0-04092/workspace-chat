import type { components } from '@workspace-chat/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { requestJson, segment } from '../api/client';
import { useSessionStore } from '../auth/session-context';

type Schemas = components['schemas'];
export type Workspace = Schemas['Workspace'];
export type Channel = Schemas['Channel'];
export type WorkspaceMember = Schemas['WorkspaceMember'];
export type UserSummary = Schemas['UserSummary'];
export type MyInvitation = Schemas['MyInvitation'];
export type Invitation = Schemas['Invitation'];

/** 自分宛ての未承諾の招待の一覧の鍵。`invitation:new` の配信（use-invitation-realtime）が取り直させる。 */
export const invitationsKey = ['invitations'] as const;

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

/** 自分宛ての未承諾の招待（届いた順。REST の仕様の listMyInvitations。F-38）。 */
export function useMyInvitations() {
  const store = useSessionStore();
  return useQuery({
    queryKey: invitationsKey,
    queryFn: () => requestJson<MyInvitation[]>(store, '/api/invitations'),
  });
}

/** 招待を承諾する（F-38）。参加が成立するので、招待の一覧と所属の一覧を取り直す。 */
export function useAcceptInvitation() {
  const store = useSessionStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) =>
      requestJson<Workspace>(store, `/api/invitations/${segment(invitationId)}/accept`, {
        method: 'POST',
      }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: invitationsKey }),
        queryClient.invalidateQueries({ queryKey: keys.workspaces, exact: true }),
      ]),
  });
}

/** 招待を辞退する（F-38）。招待が消えるだけで、所属は変わらない。 */
export function useDeclineInvitation() {
  const store = useSessionStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) =>
      requestJson<void>(store, `/api/invitations/${segment(invitationId)}/decline`, {
        method: 'POST',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: invitationsKey }),
  });
}

/** ワークスペースへ招待する（F-08。オーナーだけ。判定は api）。宛先はユーザーID。 */
export function useInviteToWorkspace(workspaceId: string) {
  const store = useSessionStore();
  return useMutation({
    mutationFn: (body: Schemas['CreateInvitationRequest']) =>
      requestJson<Invitation>(store, `/api/workspaces/${segment(workspaceId)}/invitations`, {
        method: 'POST',
        body,
      }),
  });
}

/**
 * ワークスペースから退出する（F-38）。**オーナーは api が 403 `owner_cannot_leave` で断る**（理由は画面に出す）。
 * 抜けたら、そのワークスペースの問い合わせは捨てる（もう読めない）。
 *
 * **踏むと壊れる: 所属の一覧から、抜けたワークスペースをその場で外す。取り直しの印を付けるだけにしない。**
 * 退出の時点で一覧の画面は閉じているため、`invalidateQueries` は取り直さず「古い」と印を付けるだけであり、
 * 一覧の画面へ戻ると、**取り直しが返るまでキャッシュの一覧（抜けたワークスペースを含む）が描かれる**（#533 第0巡の 🔴1）。
 */
export function useLeaveWorkspace(workspaceId: string) {
  const store = useSessionStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      requestJson<void>(store, `/api/workspaces/${segment(workspaceId)}/leave`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: keys.workspace(workspaceId) });
      queryClient.setQueryData<Workspace[]>(keys.workspaces, (workspaces) =>
        workspaces?.filter((workspace) => workspace.id !== workspaceId),
      );
      return queryClient.invalidateQueries({ queryKey: keys.workspaces, exact: true });
    },
  });
}

function membersKey(workspaceId: string) {
  return ['workspaces', workspaceId, 'members'] as const;
}

function channelMembersKey(workspaceId: string, channelId: string) {
  return ['workspaces', workspaceId, 'channels', channelId, 'members'] as const;
}

/**
 * ワークスペースのメンバー（参加した順。REST の仕様の listWorkspaceMembers。F-06）。
 * **`enabled` が false の間は読まない**——一覧を開いたときにだけ読む（画面を開くたびに読まない）。
 */
export function useWorkspaceMembers(workspaceId: string, enabled: boolean) {
  const store = useSessionStore();
  return useQuery({
    queryKey: membersKey(workspaceId),
    queryFn: () =>
      requestJson<WorkspaceMember[]>(store, `/api/workspaces/${segment(workspaceId)}/members`),
    enabled,
  });
}

/** そのワークスペースの、いずれかのチャンネルの参加者の一覧の鍵か（`channelMembersKey` の形）。 */
function isChannelMembersKeyOf(workspaceId: string, queryKey: readonly unknown[]): boolean {
  return (
    queryKey.length === 5 &&
    queryKey[0] === 'workspaces' &&
    queryKey[1] === workspaceId &&
    queryKey[2] === 'channels' &&
    queryKey[4] === 'members'
  );
}

/**
 * ワークスペースからキックする（F-09。オーナーだけ。判定は api）。
 *
 * **踏むと壊れる: 通ったら、メンバーの一覧と、読み込んである全てのチャンネルの参加者の一覧から、その相手をその場で外す。**
 * キックされた利用者は所属していた全チャンネルから外れる（機能一覧 2.2）。取り直しの印を付けるだけにすると、
 * 次に参加者の一覧を開いたとき、**取り直しが返るまでキャッシュの一覧（キックした相手を含む）が描かれる**（#533 第0巡の 🔴1 と同じ型。#540 第0巡）。
 */
export function useKickWorkspaceMember(workspaceId: string) {
  const store = useSessionStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (memberId: string) =>
      requestJson<void>(
        store,
        `/api/workspaces/${segment(workspaceId)}/members/${segment(memberId)}`,
        { method: 'DELETE' },
      ),
    onSuccess: (_, memberId) => {
      queryClient.setQueryData<WorkspaceMember[]>(membersKey(workspaceId), (members) =>
        members?.filter((member) => member.id !== memberId),
      );
      queryClient.setQueriesData<UserSummary[]>(
        { predicate: ({ queryKey }) => isChannelMembersKeyOf(workspaceId, queryKey) },
        (members) => members?.filter((member) => member.id !== memberId),
      );
    },
  });
}

/**
 * チャンネルの参加者（REST の仕様の listChannelMembers。F-10）。**`enabled` が false の間は読まない**（一覧を開いたときにだけ読む）。
 */
export function useChannelMembers(workspaceId: string, channelId: string, enabled: boolean) {
  const store = useSessionStore();
  return useQuery({
    queryKey: channelMembersKey(workspaceId, channelId),
    queryFn: () =>
      requestJson<UserSummary[]>(
        store,
        `/api/workspaces/${segment(workspaceId)}/channels/${segment(channelId)}/members`,
      ),
    enabled,
  });
}

/** チャンネルから外す（F-09。オーナーだけ。そのチャンネルだけから外す。判定は api）。通ったら、読み込んである参加者の一覧から外す。 */
export function useKickChannelMember(workspaceId: string, channelId: string) {
  const store = useSessionStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (memberId: string) =>
      requestJson<void>(
        store,
        `/api/workspaces/${segment(workspaceId)}/channels/${segment(channelId)}/members/${segment(memberId)}`,
        { method: 'DELETE' },
      ),
    onSuccess: (_, memberId) =>
      queryClient.setQueryData<UserSummary[]>(
        channelMembersKey(workspaceId, channelId),
        (members) => members?.filter((member) => member.id !== memberId),
      ),
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
 * 一覧は読み直さない——進めた後の未読数とメンションの件数は `unread:updated` で届く。
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

/** 配信で届いた未読数とメンションの件数を、読み込んである一覧に当てる。読み込んでいなければ何もしない（一覧を作らない）。 */
export function setChannelUnread(
  channels: Channel[] | undefined,
  channelId: string,
  { unread, mentions }: { unread: number; mentions: number },
): Channel[] | undefined {
  return channels?.map((channel) =>
    channel.id === channelId ? { ...channel, unread, mentions } : channel,
  );
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
