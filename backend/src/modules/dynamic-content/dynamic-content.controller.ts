import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ValidationError } from '../../common/errors';
import { WeatherProvider, type WeatherCitySearchResult } from './providers/weather.provider';
import { WeatherCitySearchRateLimitGuard } from './weather-city-search-rate-limit.guard';

@Controller('dynamic')
export class DynamicContentController {
  constructor(private readonly weather: WeatherProvider) {}

  @UseGuards(WeatherCitySearchRateLimitGuard)
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
