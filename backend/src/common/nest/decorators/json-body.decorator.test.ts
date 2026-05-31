import { describe, expect, it } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { z } from 'zod';
import { ValidationError } from '../../errors';
import { JsonBody } from './json-body.decorator';

function context(contentType: string | undefined, body: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: contentType === undefined ? {} : { 'content-type': contentType },
        body,
      }),
    }),
  } as unknown as ExecutionContext;
}

// createParamDecorator 把 factory 存在 ROUTE_ARGS_METADATA 元数据里；
// 拿出来后可以单独调它，免去拉起整套 controller。
function getFactory(): (dto: unknown, ctx: ExecutionContext) => unknown {
  class Probe {
    handler(@JsonBody({ schema: z.object({}) }) _arg: unknown): void {
      // no-op
    }
  }
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, 'handler') as Record<
    string,
    { factory: (dto: unknown, ctx: ExecutionContext) => unknown }
  >;
  const entry = Object.values(args)[0];
  if (!entry) throw new Error('factory not found');
  return entry.factory;
}

const DtoSchema = z.object({ kind: z.literal('dynamic'), name: z.string() });
const Dto = { schema: DtoSchema };

describe('JsonBody', () => {
  const factory = getFactory();

  it('returns undefined when content-type is multipart', () => {
    const ctx = context('multipart/form-data; boundary=x', undefined);
    expect(factory(Dto, ctx)).toBeUndefined();
  });

  it('returns undefined when content-type is missing', () => {
    const ctx = context(undefined, { kind: 'dynamic', name: 'ok' });
    expect(factory(Dto, ctx)).toBeUndefined();
  });

  it('parses JSON body through the dto schema', () => {
    const ctx = context('application/json', { kind: 'dynamic', name: 'ok' });
    expect(factory(Dto, ctx)).toEqual({ kind: 'dynamic', name: 'ok' });
  });

  it('throws ValidationError when JSON body fails schema', () => {
    const ctx = context('application/json', { kind: 'dynamic' });
    expect(() => factory(Dto, ctx)).toThrow(ValidationError);
  });

  it('throws ValidationError when JSON body is undefined', () => {
    const ctx = context('application/json', undefined);
    expect(() => factory(Dto, ctx)).toThrow(ValidationError);
  });
});
