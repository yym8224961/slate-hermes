import { describe, expect, it } from 'bun:test';
import type { ArgumentMetadata } from '@nestjs/common';
import { z } from 'zod';
import { ValidationError } from '../../errors';
import { ZodValidationPipe } from './zod-validation.pipe';

class RequiredDto {
  static readonly schema = z.object({ value: z.string() });
}

const pipe = new ZodValidationPipe();

describe('ZodValidationPipe', () => {
  it('allows an undefined custom parameter from JsonBody during multipart requests', () => {
    expect(
      pipe.transform(undefined, {
        type: 'custom',
        metatype: RequiredDto,
        data: undefined,
      })
    ).toBeUndefined();
  });

  it('still rejects a missing regular body', () => {
    const metadata: ArgumentMetadata = {
      type: 'body',
      metatype: RequiredDto,
      data: undefined,
    };

    expect(() => pipe.transform(undefined, metadata)).toThrow(ValidationError);
  });
});
