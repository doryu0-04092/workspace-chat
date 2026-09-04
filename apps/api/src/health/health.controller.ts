import { Controller, Get } from '@nestjs/common';
import { REALTIME_EVENT_KINDS } from '@workspace-chat/shared';

/**
 * 死活確認。認証を要さない唯一の経路とする。
 *
 * 共有パッケージの値をここで読んでいるのは、**フロントとバックが同じ定義を
 * 参照していることを、ビルドと起動の両方で確かめるため**である（CLAUDE.md 3）。
 * 型だけの参照だとビルド後に消え、実行時の結線が確認できない。
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: 'ok'; realtimeEventKinds: number } {
    return { status: 'ok', realtimeEventKinds: REALTIME_EVENT_KINDS.length };
  }
}
