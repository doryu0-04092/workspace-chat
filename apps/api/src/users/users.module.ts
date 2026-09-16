import { Module } from '@nestjs/common';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  controllers: [ProfileController, SettingsController],
  providers: [ProfileService, SettingsService],
})
export class UsersModule {}
