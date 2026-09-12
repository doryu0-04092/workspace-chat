import { Logger, Module } from '@nestjs/common';
import type Redis from 'ioredis';
import { AuthModule } from '../auth/auth.module';
import { MetricsWriter } from '../logging/metrics';
import { VALKEY_CLIENT, ValkeyModule } from '../rate-limit/rate-limit.module';
import { RealtimeEmitter } from './realtime.emitter';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeRooms } from './realtime-rooms';
import { createRealtimeValkeyClients, REALTIME_VALKEY_CLIENTS } from './realtime-valkey';

/** リアルタイム配信（F-16）。Socket.IO のサーバーの設定は createApp が RealtimeIoAdapter で当てる。 */
@Module({
  imports: [AuthModule, ValkeyModule],
  providers: [
    RealtimeGateway,
    RealtimeEmitter,
    RealtimeRooms,
    MetricsWriter,
    {
      provide: REALTIME_VALKEY_CLIENTS,
      inject: [VALKEY_CLIENT],
      useFactory: (client: Redis) => createRealtimeValkeyClients(client, new Logger('Realtime')),
    },
  ],
  exports: [RealtimeEmitter, RealtimeRooms, REALTIME_VALKEY_CLIENTS],
})
export class RealtimeModule {}
