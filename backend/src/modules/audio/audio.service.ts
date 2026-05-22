import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlink, writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { AppError, RateLimitedError } from '../../common/errors';

const execFileAsync = promisify(execFile);

const SAMPLE_RATE = 16000;
const MAX_DURATION_SEC = 60;
const MAX_OUTPUT_BYTES = SAMPLE_RATE * 2 * MAX_DURATION_SEC;
const MAX_FFMPEG_CONCURRENCY = 2;

export class AudioTranscodeError extends AppError {
  readonly code: string;
  readonly httpStatus = 400;
  constructor(message: string, code: string) {
    super(message, { code });
    this.code = code;
  }
}

@Injectable()
export class AudioService {
  private ffmpegAvailable: boolean | null = null;
  private activeFfmpeg = 0;
  private readonly ffmpegQueue: Array<() => void> = [];

  async checkFfmpegAvailable(): Promise<boolean> {
    if (this.ffmpegAvailable !== null) return this.ffmpegAvailable;
    try {
      await execFileAsync('ffmpeg', ['-version']);
      this.ffmpegAvailable = true;
    } catch {
      this.ffmpegAvailable = false;
    }
    return this.ffmpegAvailable;
  }

  async transcodeAudio(inputBuffer: Buffer): Promise<Buffer> {
    if (!(await this.checkFfmpegAvailable())) {
      throw new AudioTranscodeError('音频处理服务不可用', 'FFMPEG_NOT_FOUND');
    }

    const tmpId = randomUUID();
    const inputPath = join(tmpdir(), `audio_input_${tmpId}.bin`);
    const outputPath = join(tmpdir(), `audio_output_${tmpId}.pcm`);

    try {
      await writeFile(inputPath, inputBuffer);

      await this.runFfmpeg([
        '-i',
        inputPath,
        '-f',
        's16le',
        '-acodec',
        'pcm_s16le',
        '-ac',
        '1',
        '-ar',
        String(SAMPLE_RATE),
        '-t',
        String(MAX_DURATION_SEC),
        '-y',
        outputPath,
      ]);

      const outputBuffer = await readFile(outputPath);
      if (outputBuffer.length === 0) {
        throw new AudioTranscodeError('音频转码失败：输出为空', 'EMPTY_OUTPUT');
      }
      if (outputBuffer.length > MAX_OUTPUT_BYTES) {
        throw new AudioTranscodeError('音频时长超出限制', 'OUTPUT_TOO_LARGE');
      }
      return outputBuffer;
    } catch (err) {
      if (err instanceof AudioTranscodeError) throw err;
      throw new AudioTranscodeError('音频转码失败', 'TRANSCODE_FAILED');
    } finally {
      await unlink(inputPath).catch(() => {});
      await unlink(outputPath).catch(() => {});
    }
  }

  async resamplePcm16(inputBuffer: Buffer, inputSampleRate: number): Promise<Buffer> {
    if (inputSampleRate === SAMPLE_RATE) {
      if (inputBuffer.length > MAX_OUTPUT_BYTES) {
        throw new AudioTranscodeError('音频时长超出限制', 'OUTPUT_TOO_LARGE');
      }
      return inputBuffer;
    }
    if (!(await this.checkFfmpegAvailable())) {
      throw new AudioTranscodeError('音频处理服务不可用', 'FFMPEG_NOT_FOUND');
    }

    const tmpId = randomUUID();
    const inputPath = join(tmpdir(), `audio_pcm_input_${tmpId}.pcm`);
    const outputPath = join(tmpdir(), `audio_pcm_output_${tmpId}.pcm`);

    try {
      await writeFile(inputPath, inputBuffer);

      await this.runFfmpeg([
        '-f',
        's16le',
        '-acodec',
        'pcm_s16le',
        '-ac',
        '1',
        '-ar',
        String(inputSampleRate),
        '-i',
        inputPath,
        '-f',
        's16le',
        '-acodec',
        'pcm_s16le',
        '-ac',
        '1',
        '-ar',
        String(SAMPLE_RATE),
        '-t',
        String(MAX_DURATION_SEC),
        '-y',
        outputPath,
      ]);

      const outputBuffer = await readFile(outputPath);
      if (outputBuffer.length === 0) {
        throw new AudioTranscodeError('音频转码失败：输出为空', 'EMPTY_OUTPUT');
      }
      if (outputBuffer.length > MAX_OUTPUT_BYTES) {
        throw new AudioTranscodeError('音频时长超出限制', 'OUTPUT_TOO_LARGE');
      }
      return outputBuffer;
    } catch (err) {
      if (err instanceof AudioTranscodeError) throw err;
      throw new AudioTranscodeError('音频转码失败', 'TRANSCODE_FAILED');
    } finally {
      await unlink(inputPath).catch(() => {});
      await unlink(outputPath).catch(() => {});
    }
  }

  private async runFfmpeg(args: string[]): Promise<void> {
    const release = await this.acquireFfmpegSlot();
    try {
      await execFileAsync('ffmpeg', args, { timeout: 30_000 });
    } finally {
      release();
    }
  }

  private acquireFfmpegSlot(): Promise<() => void> {
    if (this.activeFfmpeg < MAX_FFMPEG_CONCURRENCY) {
      this.activeFfmpeg++;
      return Promise.resolve(() => this.releaseFfmpegSlot());
    }
    // 队列上限 = 并发上限 × 4。超出直接 429 fast-fail，避免突发流量把队列堆爆内存
    // 或让请求挂死 30s+。客户端按 Retry-After 重试即可。
    if (this.ffmpegQueue.length >= MAX_FFMPEG_CONCURRENCY * 4) {
      return Promise.reject(
        new RateLimitedError('音频转码繁忙，请稍后重试', { retry_after_sec: 5 })
      );
    }
    return new Promise((resolve) => {
      this.ffmpegQueue.push(() => {
        this.activeFfmpeg++;
        resolve(() => this.releaseFfmpegSlot());
      });
    });
  }

  private releaseFfmpegSlot(): void {
    this.activeFfmpeg = Math.max(0, this.activeFfmpeg - 1);
    const next = this.ffmpegQueue.shift();
    if (next) next();
  }
}
