import type { ErrorResponse } from '../error-response';

/** 自分自身とは DM を始められない（422。機能一覧 8「1対1のみ」）。 */
export const DM_WITH_SELF: ErrorResponse = {
  code: 'dm_with_self',
  message: '自分自身とはダイレクトメッセージを始められません',
};

/**
 * DM を始める相手が、このワークスペースの退会していないメンバーでない（422。機能一覧 8「相手は同一ワークスペースのメンバーに限る」）。
 * いない利用者・別のワークスペースの利用者・退会済みの利用者を区別しない。
 */
export const DM_COUNTERPART_NOT_FOUND: ErrorResponse = {
  code: 'dm_counterpart_not_found',
  message: 'その利用者はこのワークスペースのメンバーではありません',
};

/**
 * DM の相手が、いまこのワークスペースの退会していないメンバーでない（409。投稿。機能一覧 8）。
 * **当事者でない側には使わない**（当事者でなければ、DM の有無も相手も分からないよう 404 を先に返す）。
 */
export const DM_COUNTERPART_UNAVAILABLE: ErrorResponse = {
  code: 'dm_counterpart_unavailable',
  message: '相手がこのワークスペースのメンバーではなくなったため、送信できません',
};
