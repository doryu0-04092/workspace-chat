import { Module } from '@nestjs/common';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { ChannelArchiveController } from './channel-archive.controller';
import { ChannelArchiveService } from './channel-archive.service';
import { ChannelMembershipController } from './channel-membership.controller';
import { ChannelMembershipService } from './channel-membership.service';
import { ChannelRoomsGateway } from './channel-rooms.gateway';
import { ChannelRoomsService } from './channel-rooms.service';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

/**
 * ワークスペース（F-06）と招待（F-08 / F-38）とキック（F-09）とチャンネル（F-10）とチャンネルのアーカイブ（F-35）とメッセージの投稿と一覧（F-11 / F-12）。
 * チャンネルの部屋への入室要求（ChannelRoomsGateway）もここで受ける（入室の判定が所属とチャンネルの参加を見るため）。
 * 招待の通知と投稿の配信に RealtimeEmitter、参加資格を失った接続を部屋から外すのに RealtimeRooms、
 * 入室要求と投稿の上限に RateLimitModule（保存先と UserRateLimitGuard）を使う。
 */
@Module({
  imports: [RealtimeModule, RateLimitModule],
  controllers: [
    WorkspacesController,
    InvitationsController,
    ChannelsController,
    ChannelMembershipController,
    ChannelArchiveController,
    MessagesController,
  ],
  providers: [
    WorkspacesService,
    InvitationsService,
    ChannelsService,
    ChannelMembershipService,
    ChannelArchiveService,
    ChannelRoomsService,
    ChannelRoomsGateway,
    MessagesService,
  ],
})
export class WorkspacesModule {}
