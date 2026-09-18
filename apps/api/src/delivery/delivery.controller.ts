import { Controller, HttpStatus, Inject, Param, Post, Res } from '@nestjs/common';
import type { paths } from '@workspace-chat/shared';
import type { Response } from 'express';
import { type AuthenticatedUser, CurrentUser } from '../auth/access-token.guard';
import { API_CONFIG, type ApiConfig } from '../config/api-config';
import { PrismaService } from '../prisma.service';
import { assertChannelParticipant, channelFor } from '../workspaces/channel-access';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { SIGNED_COOKIE_TTL_SECONDS, type SignedCookieScope, signedCookies } from './signed-cookies';

type SignedCookiesResponse =
  paths['/avatars/cookies']['post']['responses'][200]['content']['application/json'];

/**
 * アバター（F-04。機能一覧 1.3）と添付（F-29。11.2）の配信の、CloudFront の署名付き Cookie の発行。アクセストークンを求める（AccessTokenGuard の既定）。
 * **認可を判定してから発行する**——CloudFront は Cookie の署名と対象のパスしか見ないため、発行するかどうかがそのまま配信の認可になる。
 * **CloudFront の署名鍵を設定していない環境（手元）では、判定を通ったときに 204 を返して Cookie を付けない**（API_CONFIG の cloudfrontKeyPairId）。
 * 本体は受け取らない。Cookie を送る要求ではない（Authorization ヘッダーで認証する）ため、CSRF の対処は要らない（要件定義書 4.3）。
 *
 * 応答は `@Res()` で自分で送る——状態コードが 200 と 204 に分かれ、`@HttpCode` の1つに決まらないため
 * （`passthrough` では、ハンドラが決めた状態コードを Nest が既定の 201 で上書きする）。
 */
@Controller()
export class DeliveryController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspacesService,
  ) {}

  /** ログインしている利用者に `/avatars/*` の Cookie（ワークスペースやチャンネルの参加を問わない。機能一覧 1.3）。 */
  @Post('avatars/cookies')
  avatars(@Res() res: Response): void {
    this.issue(res, { path: '/avatars' });
  }

  /**
   * そのチャンネルの参加者だけに `/files/workspace/{ws}/channel/{ch}/*` の Cookie（機能一覧 11.2）。
   * 判定はメッセージの一覧と同じ——所属していなければ 404、所属していて参加者でなければパブリックは 403・プライベートは 404（3.1 の2段階）。
   * **オーナーの例外は及ばない**（3.1。添付ファイルはオーナーの管理範囲の外）。アーカイブ済みでも参加者には発行する（読める。3.2）。
   * **キック・退出の後は、この判定に落ちて次の再発行を受けられない**（11.2）。発行済みの Cookie は期限まで有効である（要件定義書 4.3 の代償 2）。
   */
  @Post('workspaces/:id/channels/:channelId/files/cookies')
  async files(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Param('channelId') channelId: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.workspaces.membershipOf(user.id, workspaceId);
    assertChannelParticipant(await channelFor(this.prisma, user.id, workspaceId, channelId));
    this.issue(res, { path: '/files', workspaceId, channelId });
  }

  private issue(res: Response, scope: SignedCookieScope): void {
    const { cloudfrontKeyPairId: keyPairId, cloudfrontPrivateKey: privateKey } = this.config;
    // 片方だけの設定は起動時に落ちる（api-config.ts の PAIRED_SETTINGS）ため、ここでは両方あるか両方ないかである
    if (keyPairId === undefined || privateKey === undefined) {
      res.status(HttpStatus.NO_CONTENT).end();
      return;
    }
    const signer = { keyPairId, privateKey, webOrigin: this.config.webOrigin };
    for (const cookie of signedCookies(signer, scope, new Date())) {
      res.cookie(cookie.name, cookie.value, cookie.options);
    }
    const body: SignedCookiesResponse = { expiresIn: SIGNED_COOKIE_TTL_SECONDS };
    res.status(HttpStatus.OK).json(body);
  }
}
