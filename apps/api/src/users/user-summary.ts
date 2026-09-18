import type { components } from '@workspace-chat/shared';
import { Prisma } from '../generated/prisma/client';

export type UserSummary = components['schemas']['UserSummary'];

/** 利用者の要約（仕様の `UserSummary`）を作るために引く列。 */
export const USER_SUMMARY_SELECT = {
  id: true,
  loginId: true,
  displayName: true,
  avatarUrl: true,
  deletedAt: true,
} as const;

/** 要約を作るための1行（`USER_SUMMARY_SELECT` と `userSummaryColumns` が引く形）。 */
export type UserSummaryRow = {
  id: string;
  loginId: string;
  displayName: string;
  avatarUrl: string | null;
  deletedAt: Date | null;
};

/**
 * 生の SQL で要約の列を引く（`USER_SUMMARY_SELECT` の SQL の側）。`alias` は `User` の別名で、コードの定数だけを渡す（利用者の値を渡さない）。
 */
export function userSummaryColumns(alias: string): Prisma.Sql {
  return Prisma.raw(
    `${alias}."id", ${alias}."userId" AS "loginId", ${alias}."displayName", ${alias}."avatarUrl", ${alias}."deletedAt"`,
  );
}

/**
 * 列から仕様の `UserSummary` を作る。**列の名前は `loginId`、応答の名前は `userId`（ユーザーID）である**——
 * 写し間違えると `User.id` とユーザーID が入れ替わる。この写像はここだけに置く。
 * **退会した利用者の `avatarUrl` は返さない**（機能一覧 1.5）——要約はすべての経路がここを通るため、経路ごとに外さない。
 */
export function toUserSummary(user: UserSummaryRow): UserSummary {
  return {
    id: user.id,
    userId: user.loginId,
    displayName: user.displayName,
    avatarUrl: user.deletedAt === null ? user.avatarUrl : null,
  };
}
