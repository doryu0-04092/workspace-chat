import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { AccountDeletionController } from './account-deletion.controller';
import { AccountDeletionService } from './account-deletion.service';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

/** 自分のプロフィール（F-04）・設定（F-23）・アカウントの削除（F-36。パスワードの照合の制限に AuthModule、接続を切るのに RealtimeModule を使う）。 */
@Module({
  imports: [AuthModule, RealtimeModule],
  controllers: [ProfileController, SettingsController, AccountDeletionController],
  providers: [ProfileService, SettingsService, AccountDeletionService],
})
export class UsersModule {}
