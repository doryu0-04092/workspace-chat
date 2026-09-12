import type { ErrorResponse } from '../error-response';

/** ワークスペースへの招待の宛先のユーザーID の利用者がいない・退会済み（422。機能一覧 2.2）。 */
export const INVITEE_NOT_FOUND: ErrorResponse = {
  code: 'invitee_not_found',
  message: 'そのユーザーID の利用者はいません',
};

/** 同じ利用者への未承諾の招待が既にある（409。機能一覧 2.2）。 */
export const ALREADY_INVITED: ErrorResponse = {
  code: 'already_invited',
  message: 'この利用者は既に招待しています',
};

/** 宛先が既にそのワークスペースのメンバーである（409。招待・承諾。機能一覧 2.2）。 */
export const ALREADY_MEMBER: ErrorResponse = {
  code: 'already_member',
  message: 'この利用者は既にメンバーです',
};
