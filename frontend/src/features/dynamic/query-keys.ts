export const dynamicKeys = {
  weatherCities: (query: string) => ['dynamic', 'weather-cities', query] as const,
};
