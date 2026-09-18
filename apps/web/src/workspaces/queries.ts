import type { components } from '@workspace-chat/shared';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { requestJson, segment } from '../api/client';
import { useSessionStore } from '../auth/session-context';

type Schemas = components['schemas'];
export type Workspace = Schemas['Workspace'];
export type Channel = Schemas['Channel'];
export type WorkspaceMember = Schemas['WorkspaceMember'];
export type ManagedChannel = Schemas['ManagedChannel'];
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

function archivedChannelsKey(workspaceId: string) {
  return ['workspaces', workspaceId, 'archived-channels'] as const;
}

/**
 * 自分が参加しているアーカイブ済みのチャンネル（F-35。REST の仕様の listArchivedChannels。機能一覧 3.2「参加者は読める」）。
 * **`enabled` が false の間は読まない**（一覧を開いたとき・一般の一覧に無いチャンネルを開いたときにだけ読む）。
 */
export function useArchivedChannels(workspaceId: string, enabled: boolean) {
  const store = useSessionStore();
  return useQuery({
    queryKey: archivedChannelsKey(workspaceId),
    queryFn: () =>
      requestJson<Channel[]>(store, `/api/workspaces/${segment(workspaceId)}/archived-channels`),
    enabled,
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

/**
 * 招待の候補（#616。REST の仕様の listInvitationCandidates。オーナーだけ。判定は api）。**`q` が null の間は読まない**（何も入れていない）。
 * 同じ `q` はキャッシュを使う。
 */
export function useInvitationCandidates(workspaceId: string, q: string | null) {
  const store = useSessionStore();
  return useQuery({
    queryKey: ['workspaces', workspaceId, 'invitation-candidates', q],
    queryFn: () =>
      requestJson<UserSummary[]>(
        store,
        `/api/workspaces/${segment(workspaceId)}/invitation-candidates?${new URLSearchParams({ q: q ?? '' })}`,
      ),
    enabled: q !== null,
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

/**
 * 管理用の一覧の鍵。
 * **踏むと壊れる: チャンネルの参加者数か行を変える操作を足したら、通ったときにこの一覧を直すか取り直す。**
 * 行に「参加者 N 人」と参加者の一覧を並べて出しており、片方だけ変わると同じ行の中で食い違う（#545 第0巡の 🔴1）。
 */
function managedChannelsKey(workspaceId: string) {
  return ['workspaces', workspaceId, 'managed-channels'] as const;
}

/**
 * オーナーの管理用のチャンネル一覧（REST の仕様の listManagedChannels。F-35・機能一覧 3.1）。
 * 参加していないプライベートとアーカイブ済みも含み、項目は id・名前・種別・参加者数・アーカイブ済みかだけ。
 * **`enabled` が false の間は読まない**（「チャンネルを管理する」を押したときにだけ読む）。
 */
export function useManagedChannels(workspaceId: string, enabled: boolean) {
  const store = useSessionStore();
  return useQuery({
    queryKey: managedChannelsKey(workspaceId),
    queryFn: () =>
      requestJson<ManagedChannel[]>(
        store,
        `/api/workspaces/${segment(workspaceId)}/managed-channels`,
      ),
    enabled,
  });
}

/** 管理用の一覧の、同じ id の項目を置き換える。 */
function replaceManaged(
  channels: ManagedChannel[] | undefined,
  channel: ManagedChannel,
): ManagedChannel[] | undefined {
  return channels?.map((current) => (current.id === channel.id ? channel : current));
}

/**
 * チャンネルから1人外れたこと（キック・退出）を、読み込んである参加者の一覧と、管理用の一覧のそのチャンネルの人数に、取り直しを待たずに当てる。
 * **2つを1つの処理で変える**——管理用の一覧の行に並べて出しており、片方だけ変えると同じ行の中で食い違う（#545 第0巡・#549 第0巡の 🔴1）。
 */
function removeFromChannel(
  queryClient: QueryClient,
  workspaceId: string,
  channelId: string,
  memberId: string,
): void {
  queryClient.setQueryData<UserSummary[]>(channelMembersKey(workspaceId, channelId), (members) =>
    members?.filter((member) => member.id !== memberId),
  );
  queryClient.setQueryData<ManagedChannel[]>(managedChannelsKey(workspaceId), (channels) =>
    channels?.map((channel) =>
      channel.id === channelId
        ? { ...channel, memberCount: Math.max(0, channel.memberCount - 1) }
        : channel,
    ),
  );
}

/** チャンネルに1人加わったこと（招待）を、`removeFromChannel` と同じ2つに、取り直しを待たずに当てる。 */
function addToChannel(
  queryClient: QueryClient,
  workspaceId: string,
  channelId: string,
  member: UserSummary,
): void {
  queryClient.setQueryData<UserSummary[]>(channelMembersKey(workspaceId, channelId), (members) =>
    members && !members.some((current) => current.id === member.id)
      ? [...members, member]
      : members,
  );
  queryClient.setQueryData<ManagedChannel[]>(managedChannelsKey(workspaceId), (channels) =>
    channels?.map((channel) =>
      channel.id === channelId ? { ...channel, memberCount: channel.memberCount + 1 } : channel,
    ),
  );
}

/**
 * チャンネルをアーカイブする（F-35。オーナーだけ。判定は api）。
 *
 * **踏むと壊れる: 通ったら、一般のチャンネル一覧からその場で外す。取り直しの印を付けるだけにしない。**
 * アーカイブ済みは一般の一覧から外れる（機能一覧 3.2）。印を付けるだけだと、取り直しが返るまでアーカイブしたチャンネルが一覧に残る
 * （#533 第0巡の 🔴1 と同じ型）。管理用の一覧の項目は応答で置き換える（アーカイブで名前に番号が付く。general → general-1）。
 * **一般の一覧の取り直しは `exact` で当てる**——鍵の前方にはメッセージと参加者の一覧のキャッシュも入っている。
 */
export function useArchiveChannel(workspaceId: string) {
  const store = useSessionStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) =>
      requestJson<ManagedChannel>(
        store,
        `/api/workspaces/${segment(workspaceId)}/channels/${segment(channelId)}/archive`,
        { method: 'POST' },
      ),
    onSuccess: (channel) => {
      queryClient.setQueryData<ManagedChannel[]>(managedChannelsKey(workspaceId), (channels) =>
        replaceManaged(channels, channel),
      );
      queryClient.setQueryData<Channel[]>(keys.channels(workspaceId), (channels) =>
        channels?.filter((current) => current.id !== channel.id),
      );
      // アーカイブ済みの一覧（参加していれば載る）は、未読の値を画面で決められないため取り直す
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.channels(workspaceId), exact: true }),
        queryClient.invalidateQueries({ queryKey: archivedChannelsKey(workspaceId), exact: true }),
      ]);
    },
  });
}

/**
 * チャンネルを復元する（F-35。オーナーだけ。名前と番号は外れない）。
 * 通ったら管理用の一覧の項目を応答で置き換え、一般のチャンネル一覧を取り直す——一般の一覧に戻るか（パブリックか・参加しているか）と
 * 未読の値は画面では決められないため、足すのではなく読み直す。
 */
export function useRestoreChannel(workspaceId: string) {
  const store = useSessionStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) =>
      requestJson<ManagedChannel>(
        store,
        `/api/workspaces/${segment(workspaceId)}/channels/${segment(channelId)}/restore`,
        { method: 'POST' },
      ),
    onSuccess: (channel) => {
      queryClient.setQueryData<ManagedChannel[]>(managedChannelsKey(workspaceId), (channels) =>
        replaceManaged(channels, channel),
      );
      // **アーカイブ済みの一覧からは、取り直しを待たずに外す**（#533 第0巡の 🔴1）
      queryClient.setQueryData<Channel[]>(archivedChannelsKey(workspaceId), (channels) =>
        channels?.filter((current) => current.id !== channel.id),
      );
      return queryClient.invalidateQueries({ queryKey: keys.channels(workspaceId), exact: true });
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
 * **踏むと壊れる: 通ったら、メンバーの一覧と、読み込んである全てのチャンネルの参加者の一覧から、その相手をその場で外す**
 * （外したチャンネルの管理用の一覧の人数も、`removeFromChannel` で同じ処理の中で減らす）。
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
      const loaded = queryClient.getQueriesData<UserSummary[]>({
        predicate: ({ queryKey }) => isChannelMembersKeyOf(workspaceId, queryKey),
      });
      for (const [queryKey, members] of loaded) {
        if (members?.some((member) => member.id === memberId)) {
          removeFromChannel(queryClient, workspaceId, queryKey[3] as string, memberId);
        }
      }
      // 参加者の一覧を読み込んでいないチャンネルは、相手が居たかを画面が知らないため、管理用の一覧（F-35）の人数をその場では直せない。
      // **取り直す**——開いていれば即座に返り、閉じていれば次に開いたとき読む。鍵の前方には一般の一覧が入らないが、`exact` で揃える
      return queryClient.invalidateQueries({
        queryKey: managedChannelsKey(workspaceId),
        exact: true,
      });
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

/** チャンネルから外す（F-09。オーナーだけ。そのチャンネルだけから外す。判定は api）。通ったら、読み込んである参加者の一覧から外し、管理用の一覧（F-35）の人数も減らす。 */
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
    onSuccess: (_, memberId) => removeFromChannel(queryClient, workspaceId, channelId, memberId),
  });
}

/**
 * チャンネルから抜ける（F-10。REST の仕様の leaveChannel）。
 * 通ったら、一般の一覧で、パブリックは未参加に、プライベートは一覧から外す（見えなくなる）。
 * 参加者の一覧と管理用の一覧（F-35）の人数から、抜けた本人を外す。**どれも取り直しを待たずにその場で直す**（#533 第0巡の 🔴1）。
 */
export function useLeaveChannel(workspaceId: string, channelId: string) {
  const store = useSessionStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      requestJson<void>(
        store,
        `/api/workspaces/${segment(workspaceId)}/channels/${segment(channelId)}/leave`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      queryClient.setQueryData<Channel[]>(keys.channels(workspaceId), (channels) =>
        channels?.flatMap((channel) => {
          if (channel.id !== channelId) return [channel];
          if (channel.visibility === 'PRIVATE') return [];
          return [{ ...channel, joined: false }];
        }),
      );
      // アーカイブ済みのチャンネルからも抜けられる（機能一覧 3.2）。アーカイブ済みの一覧からも、取り直しを待たずに外す
      queryClient.setQueryData<Channel[]>(archivedChannelsKey(workspaceId), (channels) =>
        channels?.filter((channel) => channel.id !== channelId),
      );
      const session = store.getState();
      if (session.status === 'signedIn') {
        removeFromChannel(queryClient, workspaceId, channelId, session.user.id);
      }
      // **取り直しを待たない**——待つと、取り直しが返るまで画面を移れない（一覧はその場で直してある）
      void queryClient.invalidateQueries({ queryKey: keys.channels(workspaceId), exact: true });
    },
  });
}

/**
 * プライベートチャンネルへ招待する（F-08。REST の仕様の inviteChannelMember。招待した時点で参加する）。
 * 通ったら、参加者の一覧に足し、管理用の一覧（F-35）のそのチャンネルの人数を1人増やす。**どちらも取り直しを待たずにその場で直す**（#533 第0巡の 🔴1）。
 * 参加者の一覧の並びは api が持つので、足した後に取り直す。
 */
export function useInviteChannelMember(workspaceId: string, channelId: string) {
  const store = useSessionStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (member: UserSummary) =>
      requestJson<void>(
        store,
        `/api/workspaces/${segment(workspaceId)}/channels/${segment(channelId)}/members`,
        {
          method: 'POST',
          body: { memberId: member.id } satisfies Schemas['InviteChannelMemberRequest'],
        },
      ),
    onSuccess: (_, member) => {
      addToChannel(queryClient, workspaceId, channelId, {
        id: member.id,
        userId: member.userId,
        displayName: member.displayName,
      });
      void queryClient.invalidateQueries({
        queryKey: channelMembersKey(workspaceId, channelId),
        exact: true,
      });
    },
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
    // 管理用の一覧（F-35）の人数も変わる。どのように増えるかは取り直さないと決まらない（退会済みを数えない等は api が持つ）。
    // **一般の一覧の取り直しは `exact` で当てる**——鍵の前方にはメッセージ・返信・参加者の一覧のキャッシュも入っている
    // **参加したチャンネル自身の参加者の一覧も取り直す**——管理用の一覧の同じ行に人数と並べて出しており、人数だけ変わると食い違う（#569 第0巡の 🔴1）
    onSuccess: (_, channelId) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.channels(workspaceId), exact: true }),
        queryClient.invalidateQueries({ queryKey: managedChannelsKey(workspaceId), exact: true }),
        queryClient.invalidateQueries({
          queryKey: channelMembersKey(workspaceId, channelId),
          exact: true,
        }),
      ]),
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
    // 管理用の一覧（F-35）にも行が増える。並び（名前の順）と人数は api が持つので、足すのではなく取り直す。
    // **一般の一覧の取り直しは `exact` で当てる**（参加と同じ理由）
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.channels(workspaceId), exact: true }),
        queryClient.invalidateQueries({ queryKey: managedChannelsKey(workspaceId), exact: true }),
      ]),
  });
}
