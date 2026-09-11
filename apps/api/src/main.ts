import 'reflect-metadata';
import { bootstrap, installFatalHandlers, reportFatal } from './bootstrap';

// 起動の失敗と捕まえられなかった例外も、構造化 JSON で標準出力に出して終わる（bootstrap.ts）。
installFatalHandlers();
bootstrap().catch((error: unknown) => reportFatal(error));
