import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

/** ワークスペース（F-06）と招待（F-08 / F-38）。招待の通知に RealtimeEmitter を使う。 */
@Module({
  imports: [RealtimeModule],
  controllers: [WorkspacesController, InvitationsController],
  providers: [WorkspacesService, InvitationsService],
})
export class WorkspacesModule {}
