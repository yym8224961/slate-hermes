import { Injectable, Logger } from '@nestjs/common';
import { TtsService } from '../tts/tts.service';

// ── Types ────────────────────────────────────────────────────────────

export interface HermesChatRequest {
  text?: string;
  audio?: string;  // base64 PCM16 16kHz mono
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface HermesChatResponse {
  text: string;
  audio?: string;  // base64 PCM16 16kHz mono
}

interface PendingRequest {
  id: string;
  text: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  createdAt: number;
  resolve: (response: HermesChatResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface AgentResponse {
  requestId: string;
  text: string;
}

// ── Service ──────────────────────────────────────────────────────────

@Injectable()
export class HermesService {
  private readonly logger = new Logger(HermesService.name);

  // In-memory queue for pending requests waiting for Hermes Agent
  private pending: PendingRequest[] = [];
  // Long-poll waiters (Hermes Agent waiting for work)
  private agentWaiters: Array<{
    resolve: (req: PendingRequest | null) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  private requestCounter = 0;

  constructor(private readonly tts: TtsService) {}

  // ── Device API ────────────────────────────────────────────────────

  /** Device sends audio/text; returns response when Hermes Agent replies. */
  async chat(req: HermesChatRequest): Promise<HermesChatResponse> {
    let inputText = (req.text ?? '').trim();

    // Transcribe audio if provided
    if (!inputText && req.audio) {
      try {
        inputText = await this.transcribe(req.audio);
        this.logger.log(`STT result: ${inputText.slice(0, 80)}`);
      } catch (err) {
        this.logger.warn(`Transcription failed: ${err}`);
        return { text: '没听清，再说一次？' };
      }
    }

    if (!inputText) {
      return { text: '嗯？你想说什么？' };
    }

    // Create pending request and wait for Hermes Agent
    const reqId = `hermes-${++this.requestCounter}-${Date.now()}`;
    this.logger.log(`Request ${reqId}: waiting for Hermes Agent`);

    return new Promise<HermesChatResponse>((resolve, reject) => {
      const pending: PendingRequest = {
        id: reqId,
        text: inputText,
        history: req.history ?? [],
        createdAt: Date.now(),
        resolve: (response) => {
          // Also generate TTS before resolving
          this.addTts(response).then(resolve).catch(() => resolve(response));
        },
        reject,
        timer: setTimeout(() => {
          this.removePending(reqId);
          reject(new Error('Hermes Agent timeout'));
        }, 45000),
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
      });
      response.audio = pcm.toString('base64');
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
  async agentGetPending(timeoutMs: number = 30000): Promise<{
    requestId: string;
    text: string;
    history: Array<{ role: string; content: string }>;
  } | null> {
    // Check if there's already a pending request
    if (this.pending.length > 0) {
      const existing = this.pending.shift()!;
      clearTimeout(existing.timer);

      // Move to in-flight tracking
      this.inFlight.set(existing.id, {
        resolve: existing.resolve,
        reject: existing.reject,
        timer: setTimeout(() => {
          this.inFlight.delete(existing.id);
          existing.reject(new Error('Agent response timeout'));
        }, 60000),
      });

      this.logger.log(`Agent got request ${existing.id} (immediate)`);
      return {
        requestId: existing.id,
        text: existing.text,
        history: existing.history,
      };
    }

    // Wait for a new request via notifyAgent
    return new Promise((resolve) => {
      const waiter = {
        resolve: (req: PendingRequest | null) => {
          if (req) {
            clearTimeout(req.timer);

            // Move to in-flight tracking
            this.inFlight.set(req.id, {
              resolve: req.resolve,
              reject: req.reject,
              timer: setTimeout(() => {
                this.inFlight.delete(req.id);
                req.reject(new Error('Agent response timeout'));
              }, 60000),
            });

            this.logger.log(`Agent got request ${req.id} (via waiter)`);
            resolve({
              requestId: req.id,
              text: req.text,
              history: req.history,
            });
          } else {
            resolve(null);
          }
        },
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
  agentSubmitResponse(response: AgentResponse): boolean {
    // Find and resolve the matching pending request
    // (The pending was already removed from the queue by agentGetPending,
    //  but we keep a reference in the resolve/reject closures)
    // Since we shift() the pending in agentGetPending, we need to track
    // in-flight requests separately.

    // Actually, let me redesign: keep requests in a Map by ID
    // This is cleaner for async response handling.

    // For now, the pending is already resolved via the closure from agentGetPending.
    // But since we shifted it, we need to find the right resolve function.

    // Let me store in-flight requests
    const inFlight = this.inFlight.get(response.requestId);
    if (!inFlight) {
      this.logger.warn(`Agent response for unknown request: ${response.requestId}`);
      return false;
    }

    this.inFlight.delete(response.requestId);
    inFlight.resolve({ text: response.text });
    this.logger.log(`Agent resolved request ${response.requestId}`);
    return true;
  }

  // In-flight requests (removed from pending, waiting for agent response)
  private inFlight = new Map<string, {
    resolve: (response: HermesChatResponse) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  // ── Internal ──────────────────────────────────────────────────────

  private notifyAgent() {
    // Wake up waiting agent pollers with pending requests
    while (this.pending.length > 0 && this.agentWaiters.length > 0) {
      const req = this.pending.shift()!;
      const waiter = this.agentWaiters.shift()!;
      clearTimeout(waiter.timer);
      // inFlight tracking is handled by agentGetPending's waiter callback
      waiter.resolve(req);
    }
  }

  private removePending(id: string) {
    const idx = this.pending.findIndex((r) => r.id === id);
    if (idx >= 0) {
      const req = this.pending[idx]!;
      clearTimeout(req.timer);
      this.pending.splice(idx, 1);
      req.reject(new Error('Request timeout'));
    }
  }

  private removeWaiter(waiter: { resolve: (r: PendingRequest | null) => void; timer: ReturnType<typeof setTimeout> }) {
    const idx = this.agentWaiters.indexOf(waiter);
    if (idx >= 0) {
      clearTimeout(waiter.timer);
      this.agentWaiters.splice(idx, 1);
    }
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
        fd.append('file', new Blob([Buffer.from(audioBase64, 'base64')], { type: 'audio/wav' }), 'recording.wav');
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
