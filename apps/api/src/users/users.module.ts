import { Module } from '@nestjs/common';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { UploadsModule } from '../file-uploads/uploads.module';
import { AvatarUploadController } from './avatar-upload.controller';
import { AvatarUploadService } from './avatar-upload.service';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

/** プロフィール（F-04。アバター画像のアップロードは UploadsModule の段と、発行・確定の上限に RateLimitModule を使う）と設定（F-23）。 */
@Module({
  imports: [RateLimitModule, UploadsModule],
  controllers: [ProfileController, SettingsController, AvatarUploadController],
  providers: [ProfileService, SettingsService, AvatarUploadService],
})
export class UsersModule {}
