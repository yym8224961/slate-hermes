import { useCallback, useEffect, useMemo, useState } from 'react';
import { SearchDropdown } from '@/components/ui/SearchDropdown';
import type { City } from '@/lib/cities';
import { useWeatherCitySearch, type WeatherCityResult } from '@/features/dynamic/queries';

type CityResult = { source: 'remote'; city: WeatherCityResult } | { source: 'local'; city: City };

export function CitySearch({
  value,
  onSelect,
}: {
  value: string;
  onSelect: (result: { locationId: string; label: string }) => void;
}) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [cities, setCities] = useState<City[] | null>(null);
  const trimmedQuery = query.trim();
  const citySearch = useWeatherCitySearch(trimmedQuery, dirty);
  const shouldUseLocalFallback =
    citySearch.isError ||
    (!citySearch.isFetching && (!citySearch.data || citySearch.data.length === 0));

  const loadCities = useCallback(() => {
    if (cities) return;
    void import('@/lib/cities').then((module) => setCities(module.CITIES));
  }, [cities]);

  useEffect(() => {
    setQuery(value);
    setDirty(false);
    setOpen(false);
  }, [value]);

  useEffect(() => {
    if (dirty && trimmedQuery && shouldUseLocalFallback) loadCities();
  }, [dirty, loadCities, shouldUseLocalFallback, trimmedQuery]);

  const results = useMemo<CityResult[]>(() => {
    if (!dirty || !trimmedQuery) return [];
    if (citySearch.data && citySearch.data.length > 0) {
      return citySearch.data.map((city) => ({ source: 'remote' as const, city }));
    }
    if (shouldUseLocalFallback) {
      return searchCities(cities, trimmedQuery)
        .slice(0, 8)
        .map((city) => ({ source: 'local' as const, city }));
    }
    return [];
  }, [cities, citySearch.data, dirty, shouldUseLocalFallback, trimmedQuery]);

  useEffect(() => {
    if (results.length > 0) setOpen(true);
    else if (dirty) setOpen(false);
  }, [dirty, results.length]);

  const noResult =
    dirty &&
    trimmedQuery.length > 0 &&
    results.length === 0 &&
    !citySearch.isFetching &&
    (!shouldUseLocalFallback || cities !== null);

  return (
    <SearchDropdown
      label="城市"
      value={query}
      onValueChange={(next) => {
        setQuery(next);
        setDirty(true);
      }}
      onFocus={() => {
        if (results.length > 0) setOpen(true);
      }}
      placeholder="输入城市名或省份名，如：长沙、广东"
      results={results}
      open={open}
      onOpenChange={setOpen}
      getKey={(result) => cityResultKey(result)}
      onSelect={(result) => {
        const city = cityResultValue(result);
        onSelect({ locationId: city.locationId, label: city.label });
        setQuery(city.label);
        setDirty(false);
      }}
      renderItem={(result) => <CityResultItem result={result} />}
      noResult={
        noResult ? (
          <p className="font-sans text-[11px] text-stone mt-1.5">未找到此城市，支持省份名搜索</p>
        ) : null
      }
    />
  );
}

function CityResultItem({ result }: { result: CityResult }) {
  const city = cityResultValue(result);
  return (
    <>
      {city.label}
      {city.hint && <span className="ml-2 text-stone text-[11px]">{city.hint}</span>}
    </>
  );
}

function cityResultKey(result: CityResult): string {
  if (result.source === 'remote') return result.city.id;
  return `${result.city.name}-${result.city.province}`;
}

function cityResultValue(result: CityResult): { locationId: string; label: string; hint: string } {
  if (result.source === 'remote') {
    const city = result.city;
    const hint = [city.adm1, city.adm2].filter((part) => part && part !== city.name).join(' · ');
    return { locationId: city.id, label: city.name, hint };
  }
  const city = result.city;
  return {
    locationId: city.locationId,
    label: city.name,
    hint: city.province !== city.name ? city.province : '',
  };
}

function searchCities(cities: City[] | null, query: string): City[] {
  const q = query.trim();
  if (!q || !cities) return [];
  return cities.filter((city) => city.name.includes(q) || city.province.includes(q));
}
