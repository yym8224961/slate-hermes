import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { DeviceAuthGuard } from '../../common/nest/guards/device-auth.guard';
import { HermesService } from './hermes.service';
import type { HermesChatResponse } from './hermes.service';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/nest/pipes/zod-validation.pipe';

// ── Device endpoints (auth required) ──────────────────────────────────

const HermesChatSchema = z.object({
  text: z.string().max(1024).optional(),
  audio: z.string().max(512000).optional(),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(512),
      }),
    )
    .max(20)
    .optional(),
});

// ── Agent endpoints (internal, no device auth) ────────────────────────

const AgentResponseSchema = z.object({
  requestId: z.string().min(1).max(64),
  text: z.string().min(1).max(2048),
});

// Shared agent auth key — can be set in env to secure agent endpoints
function getAgentToken(): string {
  return process.env['HERMES_AGENT_TOKEN'] ?? 'slate-hermes-agent';
}

function checkAgentAuth(authHeader?: string): boolean {
  const token = getAgentToken();
  if (!token || token === 'slate-hermes-agent') return true; // dev mode
  const expected = `Bearer ${token}`;
  return authHeader === expected;
}

@Controller('hermes')
export class HermesController {
  constructor(private readonly hermes: HermesService) {}

  // ── Device: send audio/text, get response ─────────────────────────

  @Post('chat')
  @HttpCode(200)
  @UseGuards(DeviceAuthGuard)
  async chat(
    @Body(new ZodValidationPipe(HermesChatSchema))
    body: z.infer<typeof HermesChatSchema>,
  ): Promise<HermesChatResponse> {
    return this.hermes.chat(body);
  }

  // ── Agent: long-poll for next pending request ──────────────────────

  @Get('agent/pending')
  async agentGetPending(
    @Query('timeout') timeout?: string,
  ): Promise<{
    requestId: string;
    text: string;
    history: Array<{ role: string; content: string }>;
  } | null> {
    const ms = Math.min(Math.max(parseInt(timeout ?? '30000', 10) || 30000, 1000), 60000);
    return this.hermes.agentGetPending(ms);
  }

  // ── Agent: submit response for a pending request ───────────────────

  @Post('agent/response')
  @HttpCode(200)
  async agentSubmitResponse(
    @Body(new ZodValidationPipe(AgentResponseSchema))
    body: z.infer<typeof AgentResponseSchema>,
  ): Promise<{ ok: boolean }> {
    const ok = this.hermes.agentSubmitResponse(body);
    return { ok };
  }
}
