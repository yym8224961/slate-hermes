import { Injectable, Logger } from '@nestjs/common';
import type { HermesConnectionStatusT } from 'shared';
import { AuthError, ConflictError, ForbiddenError, RateLimitedError } from '../../common/errors';
import type { DeviceContext } from '../../common/nest/auth-context';
import { TtsService } from '../tts/tts.service';
import { HermesTokenStore } from './hermes-token.store';

const MAX_DEVICE_REPLY_AUDIO_BYTES = 16000 * 2 * 20;
const AGENT_CONNECTION_TTL_MS = 90_000;
const PENDING_TIMEOUT_MS = 30_000;
const AGENT_RESPONSE_TIMEOUT_MS = 60_000;
const HERMES_TTS_TIMEOUT_MS = 15_000;
const MAX_ACTIVE_DEVICE_REQUESTS = 32;
const MAX_DEVICE_TEXT_LENGTH = 512;

// ── Types ────────────────────────────────────────────────────────────

export interface HermesChatRequest {
  text?: string;
  audio?: string; // base64 PCM16 16kHz mono
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface HermesChatResponse {
  text: string;
  audio?: string; // base64 PCM16 16kHz mono
  /** The text the device's last voice message was transcribed to. */
  user_text?: string;
}

interface PendingRequest {
  id: string;
  deviceId: string;
  sessionId: string;
  userId: string;
  text: string;
  audio?: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  createdAt: number;
  resolve: (response: HermesChatResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface AgentResponse {
  requestId: string;
  text: string;
  userText?: string;
}

export interface HermesAgentPending {
  requestId: string;
  sessionId: string;
  userId: string;
  text: string;
  audio?: string;
  history: Array<{ role: string; content: string }>;
}

interface AgentWaiter {
  tokenRevision: number;
  resolve: (req: PendingRequest | null) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ── Service ──────────────────────────────────────────────────────────

@Injectable()
export class HermesService {
  private readonly logger = new Logger(HermesService.name);

  // In-memory queue for pending requests waiting for Hermes Agent
  private pending: PendingRequest[] = [];
  // Long-poll waiters (Hermes Agent waiting for work)
  private agentWaiters: AgentWaiter[] = [];

  private readonly activeDeviceIds = new Set<string>();

  private requestCounter = 0;
  private lastAgentSeenAt: number | null = null;

  constructor(
    private readonly tts: TtsService,
    private readonly tokenStore: HermesTokenStore
  ) {}

  async configureAgentToken(token: string): Promise<void> {
    await this.tokenStore.set(token);
    this.lastAgentSeenAt = null;
    this.invalidateStaleAgentWork();
  }

  // ── Device API ────────────────────────────────────────────────────

  /** Device sends audio/text; returns response when Hermes Agent replies. */
  async chat(req: HermesChatRequest, device: DeviceContext): Promise<HermesChatResponse> {
    if (!device.ownerUserId) {
      throw new ForbiddenError('设备必须先绑定账号才能使用 Hermes');
    }
    if (this.activeDeviceIds.has(device.deviceId)) {
      throw new ConflictError('该设备已有一条 Hermes 请求正在处理', {
        code: 'hermes_device_busy',
      });
    }
    if (this.activeDeviceIds.size >= MAX_ACTIVE_DEVICE_REQUESTS) {
      throw new RateLimitedError('Hermes 当前请求过多，请稍后重试', {
        code: 'hermes_capacity_reached',
      });
    }

    this.activeDeviceIds.add(device.deviceId);
    try {
      return await this.chatForDevice(req, device);
    } finally {
      this.activeDeviceIds.delete(device.deviceId);
    }
  }

  private async chatForDevice(
    req: HermesChatRequest,
    device: DeviceContext
  ): Promise<HermesChatResponse> {
    let inputText = (req.text ?? '').trim();
    let inputAudio: string | undefined;

    // Transcribe audio if provided
    if (!inputText && req.audio) {
      try {
        const transcript = await this.transcribe(req.audio);
        if (transcript) {
          inputText = transcript.slice(0, MAX_DEVICE_TEXT_LENGTH);
          this.logger.log(`STT result: ${inputText.slice(0, 80)}`);
        } else {
          inputAudio = req.audio;
          this.logger.warn('STT returned no text; handing audio to Hermes Agent');
        }
      } catch (err) {
        inputAudio = req.audio;
        this.logger.warn(`Transcription failed; handing audio to Hermes Agent: ${err}`);
      }
    }

    if (!inputText && !inputAudio) {
      return { text: '嗯？你想说什么？' };
    }

    // Create pending request and wait for Hermes Agent
    const reqId = `hermes-${++this.requestCounter}-${Date.now()}`;
    this.logger.log(`Request ${reqId}: waiting for Hermes Agent`);

    return new Promise<HermesChatResponse>((resolve, reject) => {
      const pending: PendingRequest = {
        id: reqId,
        deviceId: device.deviceId,
        sessionId: `slate:${device.deviceId}`,
        userId: device.ownerUserId!,
        text: inputText,
        audio: inputAudio,
        history: req.history ?? [],
        createdAt: Date.now(),
        resolve: (response) => {
          // Also generate TTS before resolving
          const returnedUserText = response.user_text?.trim();
          const responseWithUserText = returnedUserText
            ? { ...response, user_text: returnedUserText }
            : req.audio && inputText
              ? { ...response, user_text: inputText }
              : response;
          this.addTts(responseWithUserText)
            .then(resolve)
            .catch(() => resolve(responseWithUserText));
        },
        reject,
        timer: setTimeout(() => {
          this.expirePending(reqId, new Error('Hermes Agent timeout'));
        }, PENDING_TIMEOUT_MS),
      };

      this.pending.push(pending);
      this.notifyAgent();
    });
  }

  private async addTts(response: HermesChatResponse): Promise<HermesChatResponse> {
    try {
      const pcm = await this.tts.synthesizeToDevicePcm({
        text: response.text,
        voice: this.tts.defaultVoice(),
        timeoutMs: HERMES_TTS_TIMEOUT_MS,
      });
      if (pcm.byteLength > 0 && pcm.byteLength <= MAX_DEVICE_REPLY_AUDIO_BYTES) {
        response.audio = pcm.toString('base64');
      } else {
        if (pcm.byteLength > MAX_DEVICE_REPLY_AUDIO_BYTES) {
          this.logger.warn(
            `TTS reply omitted because ${pcm.byteLength} bytes exceeds the Slate limit`
          );
        }
      }
    } catch (err) {
      this.logger.warn(`TTS failed: ${err}`);
    }
    return response;
  }

  // ── Hermes Agent API ──────────────────────────────────────────────

  /**
   * Called by Hermes Agent to get the next pending request.
   * Blocks up to `timeoutMs` if no request is available.
   */
  async agentGetPending(
    timeoutMs: number = 30000,
    tokenRevision: number = this.tokenStore.revision()
  ): Promise<HermesAgentPending | null> {
    this.assertCurrentTokenRevision(tokenRevision);
    this.markAgentSeen();

    // Check if there's already a pending request
    if (this.pending.length > 0) {
      const existing = this.pending.shift()!;
      clearTimeout(existing.timer);

      this.moveToInFlight(existing, tokenRevision);

      this.logger.log(`Agent got request ${existing.id} (immediate)`);
      return this.toAgentPending(existing);
    }

    // Wait for a new request via notifyAgent
    return new Promise((resolve, reject) => {
      const waiter: AgentWaiter = {
        tokenRevision,
        resolve: (req: PendingRequest | null) => {
          if (req) {
            this.assertCurrentTokenRevision(tokenRevision);
            this.moveToInFlight(req, tokenRevision);

            this.logger.log(`Agent got request ${req.id} (via waiter)`);
            resolve(this.toAgentPending(req));
          } else {
            resolve(null);
          }
        },
        reject,
        timer: setTimeout(() => {
          this.removeWaiter(waiter);
          resolve(null);
        }, timeoutMs),
      };
      this.agentWaiters.push(waiter);
    });
  }

  /**
   * Called by Hermes Agent to submit a response for a pending request.
   */
  agentSubmitResponse(
    response: AgentResponse,
    tokenRevision: number = this.tokenStore.revision()
  ): boolean {
    this.assertCurrentTokenRevision(tokenRevision);
    this.markAgentSeen();

    const inFlight = this.inFlight.get(response.requestId);
    if (!inFlight) {
      this.logger.warn(`Agent response for unknown request: ${response.requestId}`);
      return false;
    }

    this.inFlight.delete(response.requestId);
    clearTimeout(inFlight.timer);
    const userText = response.userText?.trim();
    inFlight.request.resolve({
      text: response.text,
      ...(userText ? { user_text: userText } : {}),
    });
    this.logger.log(`Agent resolved request ${response.requestId}`);
    return true;
  }

  // In-flight requests (removed from pending, waiting for agent response)
  private inFlight = new Map<
    string,
    {
      request: PendingRequest;
      tokenRevision: number;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  // ── Internal ──────────────────────────────────────────────────────

  private notifyAgent() {
    // Wake up waiting agent pollers with pending requests
    while (this.pending.length > 0 && this.agentWaiters.length > 0) {
      const waiter = this.agentWaiters.shift()!;
      clearTimeout(waiter.timer);
      if (waiter.tokenRevision !== this.tokenStore.revision()) {
        waiter.reject(new AuthError('Hermes Agent Token 已更换'));
        continue;
      }
      const req = this.pending.shift()!;
      // inFlight tracking is handled by agentGetPending's waiter callback
      waiter.resolve(req);
    }
  }

  agentStatus(
    configured = this.tokenStore.get() !== undefined,
    now = Date.now()
  ): HermesConnectionStatusT {
    const lastSeenAt = this.lastAgentSeenAt;
    const age = lastSeenAt === null ? Number.POSITIVE_INFINITY : now - lastSeenAt;

    return {
      enabled: configured,
      connected: configured && age >= 0 && age <= AGENT_CONNECTION_TTL_MS,
      last_seen_at: lastSeenAt === null ? null : new Date(lastSeenAt).toISOString(),
    };
  }

  private markAgentSeen() {
    this.lastAgentSeenAt = Date.now();
  }

  private expirePending(id: string, error: Error) {
    const idx = this.pending.findIndex((r) => r.id === id);
    if (idx >= 0) {
      const req = this.pending[idx]!;
      clearTimeout(req.timer);
      this.pending.splice(idx, 1);
      req.reject(error);
    }
  }

  private removeWaiter(waiter: AgentWaiter) {
    const idx = this.agentWaiters.indexOf(waiter);
    if (idx >= 0) {
      clearTimeout(waiter.timer);
      this.agentWaiters.splice(idx, 1);
    }
  }

  private assertCurrentTokenRevision(tokenRevision: number): void {
    if (tokenRevision !== this.tokenStore.revision()) {
      throw new AuthError('Hermes Agent Token 已更换');
    }
  }

  private toAgentPending(req: PendingRequest): HermesAgentPending {
    return {
      requestId: req.id,
      sessionId: req.sessionId,
      userId: req.userId,
      text: req.text,
      audio: req.audio,
      history: req.history,
    };
  }

  private moveToInFlight(req: PendingRequest, tokenRevision: number): void {
    clearTimeout(req.timer);
    this.inFlight.set(req.id, {
      request: req,
      tokenRevision,
      timer: setTimeout(() => {
        this.inFlight.delete(req.id);
        req.reject(new Error('Agent response timeout'));
      }, AGENT_RESPONSE_TIMEOUT_MS),
    });
  }

  private invalidateStaleAgentWork(): void {
    const currentRevision = this.tokenStore.revision();
    const waiters = this.agentWaiters.splice(0);
    for (const waiter of waiters) {
      if (waiter.tokenRevision === currentRevision) {
        this.agentWaiters.push(waiter);
      } else {
        clearTimeout(waiter.timer);
        waiter.reject(new AuthError('Hermes Agent Token 已更换'));
      }
    }

    const requeued: PendingRequest[] = [];
    for (const [id, inFlight] of this.inFlight) {
      if (inFlight.tokenRevision === currentRevision) continue;
      clearTimeout(inFlight.timer);
      this.inFlight.delete(id);
      const request = inFlight.request;
      request.createdAt = Date.now();
      request.timer = setTimeout(() => {
        this.expirePending(request.id, new Error('Hermes Agent timeout'));
      }, PENDING_TIMEOUT_MS);
      requeued.push(request);
    }
    this.pending.unshift(...requeued);
    this.logger.log(`Hermes Agent Token rotated to revision ${currentRevision}`);
  }

  /** Transcribe audio via Whisper-compatible endpoint. */
  private async transcribe(audioBase64: string): Promise<string> {
    const baseUrl = process.env['AI_BASE_URL']?.replace(/\/+$/, '') ?? '';
    const apiKey = process.env['AI_API_KEY'] ?? '';

    if (!baseUrl || !apiKey) throw new Error('AI not configured for STT');

    const resp = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: (() => {
        const fd = new FormData();
        const pcm = Buffer.from(audioBase64, 'base64');
        if (pcm.length === 0 || pcm.length % 2 !== 0) {
          throw new Error('Invalid PCM16 audio payload');
        }
        fd.append('file', new Blob([pcmToWav(pcm)], { type: 'audio/wav' }), 'recording.wav');
        fd.append('model', 'whisper-1');
        return fd;
      })(),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`STT HTTP ${resp.status}: ${detail.slice(0, 200)}`);
    }

    const body = await resp.text();
    try {
      return (JSON.parse(body) as { text?: string }).text?.trim() ?? '';
    } catch {
      return body.trim();
    }
  }

  /** Clean up stale requests (called periodically or on module destroy). */
  cleanup() {
    const now = Date.now();
    this.pending = this.pending.filter((r) => {
      if (now - r.createdAt > 60000) {
        clearTimeout(r.timer);
        r.reject(new Error('Request expired'));
        return false;
      }
      return true;
    });
  }
}

export function pcmToWav(pcm: Uint8Array): Uint8Array {
  const sampleRate = 16000;
  const channels = 1;
  const bitsPerSample = 16;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28);
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}
