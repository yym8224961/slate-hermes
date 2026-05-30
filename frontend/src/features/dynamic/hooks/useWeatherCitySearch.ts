import { useQuery } from '@tanstack/react-query';
import { API_PREFIX, api } from '@/lib/http';

const weatherCityQueryKey = (query: string) => ['dynamic', 'weather-cities', query] as const;

export interface WeatherCityResult {
  id: string;
  name: string;
  adm1: string;
  adm2: string;
}

export function useWeatherCitySearch(query: string, enabled: boolean) {
  const q = query.trim();
  return useQuery({
    queryKey: weatherCityQueryKey(q),
    queryFn: async () => {
      const { data } = await api.get<WeatherCityResult[]>(`${API_PREFIX}/dynamic/weather/cities`, {
        params: { q },
      });
      return data;
    },
    enabled: enabled && q.length > 0,
    staleTime: 60 * 60 * 1000,
  });
}
