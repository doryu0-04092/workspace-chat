import type { ErrorResponse } from '../error-response';

/** 同じワークスペースに同じ名前のチャンネルがある（409。一意索引 `Channel_workspaceId_name_key`）。 */
export const CHANNEL_NAME_TAKEN: ErrorResponse = {
  code: 'channel_name_taken',
  message: 'この名前のチャンネルは既にあります',
};

/**
 * パブリックチャンネルに参加していない（403。機能一覧 3.1 の2段階のコードの、所属していてパブリックの側）。
 * **プライベートチャンネルには使わない**（参加していなければ 404 で存在を隠す）。
 */
export const NOT_A_CHANNEL_MEMBER: ErrorResponse = {
  code: 'not_a_channel_member',
  message: 'このチャンネルの参加者ではありません',
};

/** 既にそのチャンネルの参加者である（409。参加・招待。一意索引 `ChannelMember_channelId_userId_key`）。 */
export const ALREADY_CHANNEL_MEMBER: ErrorResponse = {
  code: 'already_channel_member',
  message: '既にこのチャンネルの参加者です',
};

/** アーカイブ済みのチャンネルには人を増やせない（409。参加・招待。機能一覧 3.2）。 */
export const CHANNEL_ARCHIVED: ErrorResponse = {
  code: 'channel_archived',
  message: 'アーカイブ済みのチャンネルです',
};

/** アーカイブしていないチャンネルは復元できない（409。機能一覧 3.2）。 */
export const CHANNEL_NOT_ARCHIVED: ErrorResponse = {
  code: 'channel_not_archived',
  message: 'アーカイブしていないチャンネルです',
};

/** パブリックチャンネルへは招待しない（422。自由に参加できるため。機能一覧 2.2・3.1）。 */
export const CHANNEL_NOT_PRIVATE: ErrorResponse = {
  code: 'channel_not_private',
  message: 'パブリックチャンネルには招待できません（各自が参加します）',
};

/**
 * 招待の宛先が、そのワークスペースのメンバーでない・退会済み（422。機能一覧 2.2・1.5）。
 * code はワークスペースへの招待と同じだが、宛先を User.id で指すため文言が違う。
 */
export const CHANNEL_INVITEE_NOT_FOUND: ErrorResponse = {
  code: 'invitee_not_found',
  message: 'その利用者はこのワークスペースのメンバーではありません',
};
