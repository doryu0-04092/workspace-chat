import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { type AuthenticatedUser, CurrentUser } from '../auth/access-token.guard';
import {
  type CreateWorkspaceRequest,
  type Workspace,
  type WorkspaceMember,
  WorkspacesService,
} from './workspaces.service';

/**
 * ワークスペースの作成・一覧・取得・参加者一覧（F-06。機能一覧 2.1）。アクセストークンを求める（AccessTokenGuard の既定）。
 *
 * **入力の形（名前の長さ・`id` の形）はここでは確かめない**（profile.controller.ts と同じ。openapi-validation.ts が仕様で確かめる）。
 */
@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateWorkspaceRequest,
  ): Promise<Workspace> {
    return this.workspaces.create(user.id, body);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<Workspace[]> {
    return this.workspaces.list(user.id);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<Workspace> {
    return this.workspaces.get(user.id, id);
  }

  @Get(':id/members')
  members(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<WorkspaceMember[]> {
    return this.workspaces.members(user.id, id);
  }
}
