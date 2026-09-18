import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { AccountDeletionController } from './account-deletion.controller';
import { AccountDeletionService } from './account-deletion.service';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { UploadsModule } from '../file-uploads/uploads.module';
import { AvatarUploadController } from './avatar-upload.controller';
import { AvatarUploadService } from './avatar-upload.service';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

/** 自分のプロフィール（F-04。アバター画像のアップロードは UploadsModule の段と、発行・確定の上限に RateLimitModule を使う）・設定（F-23）・アカウントの削除（F-36。パスワードの照合の制限に AuthModule、接続を切るのに RealtimeModule を使う）。 */
@Module({
  imports: [AuthModule, RealtimeModule, RateLimitModule, UploadsModule],
  controllers: [
    ProfileController,
    SettingsController,
    AccountDeletionController,
    AvatarUploadController,
  ],
  providers: [ProfileService, SettingsService, AccountDeletionService, AvatarUploadService],
})
export class UsersModule {}
