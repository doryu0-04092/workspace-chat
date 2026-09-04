import 'reflect-metadata';
import { Controller, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

/**
 * コンストラクタインジェクションが、テストの実行環境でも成立することを見る。
 *
 * **これは製品の機能ではなく、テストの変換設定に対する検査である。**
 * Nest は型による依存の解決に、TypeScript の `emitDecoratorMetadata` が出す
 * `design:paramtypes` を使う。この出力を持たない変換器でテストを走らせると、
 * Nest は解決に失敗せず undefined を注入し、使う瞬間に別の場所で落ちる（#14）。
 *
 * 検証用のクラスはこのファイルの中に閉じる。製品コードに置くと、要件に無いものが
 * `dist/` に出る（CLAUDE.md 1）。
 */

@Injectable()
class ProbeService {
  readonly value = 'injected';
}

@Controller()
class ProbeController {
  constructor(private readonly probe: ProbeService) {}

  read(): string {
    return this.probe.value;
  }
}

describe('コンストラクタインジェクション', () => {
  // 下の「解決される」だけでも変換設定が壊れれば落ちる。ただしその失敗は
  // 「undefined の value を読めない」であり、原因である変換設定を指さない。
  // 原因に直接あたる検査を先に置き、落ちたときに読む順序を作る。
  it('依存の型がメタデータとして出力されている', () => {
    expect(Reflect.getMetadata('design:paramtypes', ProbeController)).toEqual([ProbeService]);
  });

  it('コンストラクタの依存が解決される', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [ProbeService],
    }).compile();

    expect(moduleRef.get(ProbeController).read()).toBe('injected');
  });
});
