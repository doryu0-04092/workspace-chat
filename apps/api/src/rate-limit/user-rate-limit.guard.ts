import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { authenticatedUserOf } from '../auth/access-token.guard';
import { UserRateLimitException } from '../error-response';

/**
 * 利用者単位のレート制限（メッセージの投稿。機能一覧 4.1）。数える単位は発信元（`req.ip`）ではなく、AccessTokenGuard が解決した利用者である。
 *
 * - **AccessTokenGuard（APP_GUARD）の後に走る**——全体のガードはルートのガードより先に走るため、ここでは利用者が必ず載っている
 * - 使う側は `@UseGuards(UserRateLimitGuard)` と `@Throttle({ default: … })` で上限を決める。保存先は RateLimitGuard と同じ
 * - 超えたら `UserRateLimitException`（429）。記録は ErrorResponseFilter が `limit: 'user'` で残す
 */
@Injectable()
export class UserRateLimitGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    return this.userIdOf(req);
  }

  protected override async throwThrottlingException(
    context: Parameters<ThrottlerGuard['throwThrottlingException']>[0],
  ): Promise<void> {
    throw new UserRateLimitException(this.userIdOf(context.switchToHttp().getRequest<object>()));
  }

  private userIdOf(request: object): string {
    const user = authenticatedUserOf(request);
    // 認証を要するルートにだけ付ける。ここに利用者が無いのは組み立ての誤りである。
    if (!user) throw new Error('UserRateLimitGuard は認証を要するルートでだけ使う');
    return user.id;
  }
}
