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
import { DmsController } from './dms.controller';
import { DmsService } from './dms.service';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { ReactionsController } from './reactions.controller';
import { ReactionsService } from './reactions.service';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

/**
 * ワークスペース（F-06）と招待（F-08 / F-38）とキック（F-09）とチャンネル（F-10）とチャンネルのアーカイブ（F-35）とメッセージの投稿・一覧・編集・削除（F-11 / F-12 / F-13）とスレッドの返信（F-17）と検索（F-30・F-31）。
 * チャンネルの部屋への入室要求（ChannelRoomsGateway）もここで受ける（入室の判定が所属とチャンネルの参加を見るため）。
 * 招待の通知とメッセージの投稿・返信・編集・削除の配信に RealtimeEmitter、参加資格を失った接続を部屋から外すのに RealtimeRooms、
 * 入室要求とメッセージの投稿・返信・編集・削除の上限に RateLimitModule（保存先と MessageWriteRateLimitGuard）を使う。
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
    DmsController,
    SearchController,
    ReactionsController,
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
    DmsService,
    SearchService,
    ReactionsService,
  ],
})
export class WorkspacesModule {}
