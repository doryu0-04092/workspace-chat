import type { components } from '@workspace-chat/shared';

export type UserSummary = components['schemas']['UserSummary'];

/** 利用者の要約（仕様の `UserSummary`）を作るために引く列。 */
export const USER_SUMMARY_SELECT = { id: true, loginId: true, displayName: true } as const;

/**
 * 列から仕様の `UserSummary` を作る。**列の名前は `loginId`、応答の名前は `userId`（ユーザーID）である**——
 * 写し間違えると `User.id` とユーザーID が入れ替わる。この写像はここだけに置く。
 */
export function toUserSummary(user: {
  id: string;
  loginId: string;
  displayName: string;
}): UserSummary {
  return { id: user.id, userId: user.loginId, displayName: user.displayName };
}
