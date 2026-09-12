import { Prisma } from '../generated/prisma/client';

/**
 * DB の応答を差し替えるための、Prisma の一意制約違反（P2002）。**製品コードから読み込まない**（tsconfig.build.json が外す）。
 *
 * **一意制約違反を 409 に写す経路は、要求の順序に依らず違反の経路を踏むテストを持つ**（#355）。
 * 実際の DB を使う検査は、作成の前に SELECT で確かめる形へ変えても、要求が重ならなければ落ちない。
 * 差し替えは、その形へ変えても決まった形で違反の経路を踏む（`isUniqueViolation` は `code` だけを見る。prisma-errors.ts）。
 */
export function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}
