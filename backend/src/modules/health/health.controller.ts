import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/nest/decorators/auth-context.decorators';

@Controller()
export class HealthController {
  @Public()
  @Get('healthz')
  health(): { status: 'ok'; ts: string } {
    return { status: 'ok', ts: new Date().toISOString() };
  }
}
