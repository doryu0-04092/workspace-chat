import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { ChannelArchiveController } from './channel-archive.controller';
import { ChannelArchiveService } from './channel-archive.service';
import { ChannelMembershipController } from './channel-membership.controller';
import { ChannelMembershipService } from './channel-membership.service';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

/** ワークスペース（F-06）と招待（F-08 / F-38）とチャンネル（F-10）。招待の通知に RealtimeEmitter を使う。 */
@Module({
  imports: [RealtimeModule],
  controllers: [
    WorkspacesController,
    InvitationsController,
    ChannelsController,
    ChannelMembershipController,
    ChannelArchiveController,
  ],
  providers: [
    WorkspacesService,
    InvitationsService,
    ChannelsService,
    ChannelMembershipService,
    ChannelArchiveService,
  ],
})
export class WorkspacesModule {}
