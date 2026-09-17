import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { type AuthenticatedUser, CurrentUser } from '../auth/access-token.guard';
import { UserRateLimitGuard } from '../rate-limit/user-rate-limit.guard';
import { type SearchResult, SearchService } from './search.service';

/**
 * 検索の上限（利用者ごとに1分 60 回。機能一覧 12.1。実装時に決めた値）。
 * **上限を置くのは、1要求が種別ごとの問い合わせを3本（本文の全文照合を含む）起こすためである**（CWE-770）。
 * **踏むと壊れる: 変えるなら `packages/shared/openapi/openapi.yaml` の `search` の description も同じ値にする。**
 */
export const SEARCH_LIMIT = { limit: 60, ttl: 60 * 1000 } as const;

/**
 * 検索（F-30・F-31。機能一覧 12.1）。アクセストークンを求める（AccessTokenGuard の既定）。
 * **`q` の形（1〜200 文字・空白だけは不可）はここでは確かめない**（openapi-validation.ts が仕様で確かめる）。
 */
@Controller('workspaces/:id')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get('search')
  @UseGuards(UserRateLimitGuard)
  @Throttle({ default: SEARCH_LIMIT })
  search(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') workspaceId: string,
    @Query('q') q: string,
  ): Promise<SearchResult> {
    return this.searchService.search(user.id, workspaceId, q);
  }
}
