import { useQuery } from '@tanstack/react-query';
import { API_V1, api } from '@/lib/http';
import { queryKeys } from '@/lib/query-keys';

export interface WeatherCityResult {
  id: string;
  name: string;
  adm1: string;
  adm2: string;
}

export function useWeatherCitySearch(query: string, enabled: boolean) {
  const q = query.trim();
  return useQuery({
    queryKey: queryKeys.dynamic.weatherCities(q),
    queryFn: async () => {
      const { data } = await api.get<WeatherCityResult[]>(`${API_V1}/dynamic/weather/cities`, {
        params: { q },
      });
      return data;
    },
    enabled: enabled && q.length > 0,
    staleTime: 60 * 60 * 1000,
  });
}
