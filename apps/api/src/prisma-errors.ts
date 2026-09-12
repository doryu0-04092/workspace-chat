import { Prisma } from './generated/prisma/client';

/**
 * 一意制約の違反（Prisma の P2002）。**不変条件は DB の一意索引が持ち、ここは違反を 409 に写すためだけに使う**
 * （先に `findFirst` で確かめる形にすると、同時の2件目が一意索引の違反で 500 になる）。
 */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
