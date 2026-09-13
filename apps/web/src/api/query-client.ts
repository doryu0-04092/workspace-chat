import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './client';

/** 読み込みをやり直すか。api が 4xx で断ったものは、やり直しても結果が変わらない。 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.failure.status >= 400 && error.failure.status < 500) {
    return false;
  }
  return failureCount < 2;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: shouldRetry } } });
}
