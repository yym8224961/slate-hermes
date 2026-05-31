import { Controller, Get, Query } from '@nestjs/common';
import { ValidationError } from '../../common/errors';
import { RateLimit } from '../../common/rate-limit/rate-limit-guard';
import { WeatherProvider, type WeatherCitySearchResult } from './providers/weather.provider';
import { weatherCitySearchRateLimit } from './dynamic-rate-limits';

@Controller('dynamic')
export class WeatherCityController {
  constructor(private readonly weather: WeatherProvider) {}

  @RateLimit(weatherCitySearchRateLimit)
  @Get('weather/cities')
  async searchWeatherCities(
    @Query('q') query: string | undefined
  ): Promise<WeatherCitySearchResult[]> {
    const q = query?.trim() ?? '';
    if (q.length < 1) return [];
    if (q.length > 32) throw new ValidationError('城市搜索关键词最多 32 个字符');
    return this.weather.searchCities(q, 8);
  }
}
