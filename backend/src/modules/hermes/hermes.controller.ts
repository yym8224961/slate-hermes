import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { DeviceAuthGuard } from '../../common/nest/guards/device-auth.guard';
import { Public } from '../../common/nest/decorators/auth-context.decorators';
import { HermesService } from './hermes.service';
import type { HermesChatResponse } from './hermes.service';
import { z } from 'zod';
import type { HermesConnectionStatusT } from 'shared';
import { HermesAgentAuthGuard } from './hermes-agent-auth.guard';

// ── Device endpoints (auth required) ──────────────────────────────────

const HermesChatSchema = z.object({
  text: z.string().max(1024).optional(),
  // 15 seconds of 16 kHz mono PCM16 is 480 KB, or 640 KB after base64 encoding.
  audio: z.string().max(640000).optional(),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(512),
      })
    )
    .max(20)
    .optional(),
});

class HermesChatDto implements z.infer<typeof HermesChatSchema> {
  static readonly schema = HermesChatSchema;
  declare text?: string;
  declare audio?: string;
  declare history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

// ── Agent endpoints (internal, no device auth) ────────────────────────

const AgentResponseSchema = z.object({
  requestId: z.string().min(1).max(64),
  text: z.string().min(1).max(2048),
  userText: z.string().max(1024).optional(),
});

const HermesAgentTokenSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9._~-]{32,256}$/),
});

class HermesAgentTokenDto implements z.infer<typeof HermesAgentTokenSchema> {
  static readonly schema = HermesAgentTokenSchema;
  declare token: string;
}

class AgentResponseDto implements z.infer<typeof AgentResponseSchema> {
  static readonly schema = AgentResponseSchema;
  declare requestId: string;
  declare text: string;
  declare userText?: string;
}

@Controller('hermes')
export class HermesController {
  constructor(private readonly hermes: HermesService) {}

  // ── Web: inspect integration status without exposing the shared token ──

  @Get('status')
  status(): HermesConnectionStatusT {
    return this.hermes.agentStatus();
  }

  @Post('token')
  @HttpCode(200)
  async configureToken(@Body() body: HermesAgentTokenDto): Promise<{ configured: true }> {
    await this.hermes.configureAgentToken(body.token);
    return { configured: true };
  }

  // ── Device: send audio/text, get response ─────────────────────────

  @Post('chat')
  @HttpCode(200)
  @Public()
  @UseGuards(DeviceAuthGuard)
  async chat(@Body() body: HermesChatDto): Promise<HermesChatResponse> {
    return this.hermes.chat(body);
  }

  // ── Agent: long-poll for next pending request ──────────────────────

  @Get('agent/pending')
  @Public()
  @UseGuards(HermesAgentAuthGuard)
  async agentGetPending(@Query('timeout') timeout?: string): Promise<{
    requestId: string;
    text: string;
    audio?: string;
    history: Array<{ role: string; content: string }>;
  } | null> {
    const ms = Math.min(Math.max(parseInt(timeout ?? '30000', 10) || 30000, 1000), 60000);
    return this.hermes.agentGetPending(ms);
  }

  // ── Agent: submit response for a pending request ───────────────────

  @Post('agent/response')
  @HttpCode(200)
  @Public()
  @UseGuards(HermesAgentAuthGuard)
  async agentSubmitResponse(@Body() body: AgentResponseDto): Promise<{ ok: boolean }> {
    const ok = this.hermes.agentSubmitResponse(body);
    return { ok };
  }
}
