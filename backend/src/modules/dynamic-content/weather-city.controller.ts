import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { WeatherCitySearchResult } from './providers/weather.provider';
import { DynamicContentService } from './dynamic-content.service';
import { WeatherCitySearchRateLimitGuard } from './weather-city-search-rate-limit.guard';

@Controller('dynamic')
export class WeatherCityController {
  constructor(private readonly dynamicContent: DynamicContentService) {}

  @UseGuards(WeatherCitySearchRateLimitGuard)
  @Get('weather/cities')
  async searchWeatherCities(
    @Query('q') query: string | undefined
  ): Promise<WeatherCitySearchResult[]> {
    return this.dynamicContent.searchWeatherCities(query);
  }
}
