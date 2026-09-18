import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/** 受け取った通知の一覧と既読化（F-26。機能一覧 10.3）。通知の行はメッセージの投稿・返信・編集と同じトランザクションで作る（`mention-notifications.ts`）。 */
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
})
export class NotificationsModule {}
