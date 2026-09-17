import { Module } from '@nestjs/common';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { DeliveryController } from './delivery.controller';

/**
 * アバター（F-04）と添付（F-29）の配信の、CloudFront の署名付き Cookie の発行。
 * 添付の Cookie の判定に、ワークスペースの所属（WorkspacesService）を使う。
 */
@Module({
  imports: [WorkspacesModule],
  controllers: [DeliveryController],
})
export class DeliveryModule {}
