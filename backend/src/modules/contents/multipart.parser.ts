import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { DITHER_MODES, type DitherMode } from 'shared';
import { ValidationError } from '../../common/errors';

export interface ParsedContentUpload {
  hasImage: boolean;
  imageBuf: Buffer | null;
  hasAudio: boolean;
  audioBuf: Buffer | null;
  threshold?: number;
  mode?: DitherMode;
  hasTitle: boolean;
  title: string | null;
}

const MODES = DITHER_MODES as readonly string[];

@Injectable()
export class MultipartParser {
  async parseContentUpload(req: FastifyRequest): Promise<ParsedContentUpload> {
    if (!req.isMultipart()) {
      throw new ValidationError('请求格式错误，请使用 multipart/form-data', {
        code: 'not_multipart',
      });
    }
    const result: ParsedContentUpload = {
      hasImage: false,
      imageBuf: null,
      hasAudio: false,
      audioBuf: null,
      hasTitle: false,
      title: null,
    };
    const parts = req.parts();
    for await (const part of parts) {
      if (part.type === 'file') {
        const buf = await part.toBuffer();
        if (part.fieldname === 'image') {
          result.hasImage = buf.length > 0;
          if (result.hasImage) result.imageBuf = buf;
        } else if (part.fieldname === 'audio') {
          result.hasAudio = buf.length > 0;
          if (result.hasAudio) result.audioBuf = buf;
        }
      } else {
        const val = typeof part.value === 'string' ? part.value : String(part.value ?? '');
        if (part.fieldname === 'threshold' && val !== '') {
          const n = Number(val);
          if (Number.isFinite(n)) {
            result.threshold = Math.max(0, Math.min(255, n));
          }
        } else if (part.fieldname === 'mode' && MODES.includes(val)) {
          result.mode = val as DitherMode;
        } else if (part.fieldname === 'title') {
          result.hasTitle = true;
          const trimmed = val.trim().slice(0, 64);
          result.title = trimmed === '' ? null : trimmed;
        }
      }
    }
    return result;
  }
}
