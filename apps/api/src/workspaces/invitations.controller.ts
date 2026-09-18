import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { type AuthenticatedUser, CurrentUser } from '../auth/access-token.guard';
import { UserRateLimitGuard } from '../rate-limit/user-rate-limit.guard';
import {
  type CreateInvitationRequest,
  type Invitation,
  InvitationsService,
  type MyInvitation,
} from './invitations.service';
import type { Workspace } from './workspaces.service';

/**
 * 招待の候補の上限（利用者ごとに1分 60 回。#616。実装時に決めた値）。1要求が利用者の表への部分一致の問い合わせを1本起こすため（CWE-770）。
 * **踏むと壊れる: 変えるなら openapi.yaml の `listInvitationCandidates` の description も同じ値にする。**
 */
export const INVITATION_CANDIDATES_LIMIT = { limit: 60, ttl: 60 * 1000 } as const;

/**
 * ワークスペースへの招待と、招待の承諾・辞退（F-08 / F-38。機能一覧 2.2）。アクセストークンを求める（AccessTokenGuard の既定）。
 *
 * **入力の形（ユーザーID の長さ・`id` の形）はここでは確かめない**（openapi-validation.ts が仕様で確かめる）。
 */
@Controller()
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post('workspaces/:id/invitations')
  invite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Body() body: CreateInvitationRequest,
  ): Promise<Invitation> {
    return this.invitations.invite(user.id, workspaceId, body);
  }

  @Get('workspaces/:id/invitation-candidates')
  @UseGuards(UserRateLimitGuard)
  @Throttle({ default: INVITATION_CANDIDATES_LIMIT })
  candidates(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Query('q') q: string,
  ): ReturnType<InvitationsService['candidates']> {
    return this.invitations.candidates(user.id, workspaceId, q);
  }

  @Get('invitations')
  mine(@CurrentUser() user: AuthenticatedUser): Promise<MyInvitation[]> {
    return this.invitations.mine(user.id);
  }

  @Post('invitations/:id/accept')
  @HttpCode(HttpStatus.OK)
  accept(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<Workspace> {
    return this.invitations.accept(user.id, id);
  }

  @Post('invitations/:id/decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  decline(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    return this.invitations.decline(user.id, id);
  }
}
