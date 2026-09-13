import { Prisma } from './generated/prisma/client';

/**
 * 一意制約の違反（Prisma の P2002）。**不変条件は DB の一意索引が持ち、ここは違反を捕まえて 409 に写すか、
 * アーカイブの採番をやり直す（`workspaces/channel-archive.service.ts`）ためだけに使う**
 * （先に `findFirst` で確かめる形にすると、同時の2件目が一意索引の違反で 500 になる）。
 * **この関数で 409 に写す経路は、DB の応答を差し替えて違反の経路を踏むテストを持つ**（規則は `testing/prisma-violations.ts`）。
 */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * 外部キーの違反（Prisma の P2003）。**不変条件は DB の外部キーが持ち、ここは参照先が同時に消えたこと
 * （例: 参加を作る間に、その利用者がワークスペースから外れた）を応答に写すためだけに使う。**
 */
export function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}
