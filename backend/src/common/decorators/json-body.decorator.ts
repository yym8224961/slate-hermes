import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ZodError, type ZodType } from 'zod';
import { ValidationError } from '../errors';

interface JsonBodyDto {
  schema: ZodType;
}

// polymorphic 端点（multipart + JSON 共用一个路由）用这个替代 @Body()：
// multipart 时 req.body 是 undefined，全局 ZodValidationPipe 会把 undefined 当非法对象拒绝；
// 这里只在 content-type 是 application/json 时跑 zod，否则返回 undefined 让 controller 自己分支。
export const JsonBody = createParamDecorator(
  (dtoClass: JsonBodyDto, ctx: ExecutionContext): unknown => {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const ct = req.headers['content-type'] ?? '';
    if (!ct.startsWith('application/json')) return undefined;
    try {
      return dtoClass.schema.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError('请求参数验证失败', { issues: err.issues });
      }
      throw err;
    }
  }
);
