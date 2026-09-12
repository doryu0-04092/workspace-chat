import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { type AuthenticatedUser, CurrentUser } from '../auth/access-token.guard';
import {
  type CreateInvitationRequest,
  type Invitation,
  InvitationsService,
  type MyInvitation,
} from './invitations.service';
import type { Workspace } from './workspaces.service';

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
