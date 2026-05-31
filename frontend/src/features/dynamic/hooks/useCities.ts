import { useCallback, useEffect, useState } from 'react';
import type { City } from '@/features/dynamic/model/cities';

let citiesPromise: Promise<City[]> | null = null;

function fetchCities(): Promise<City[]> {
  citiesPromise ??= import('@/features/dynamic/model/cities').then((module) => module.CITIES);
  return citiesPromise;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    citiesPromise = null;
  });
}

export function useCities(preload = false) {
  const [cities, setCities] = useState<City[] | null>(null);

  const loadCities = useCallback(() => {
    if (cities) return;
    void fetchCities().then(setCities);
  }, [cities]);

  useEffect(() => {
    if (!preload || cities) return;
    let cancelled = false;
    void fetchCities().then((nextCities) => {
      if (!cancelled) setCities(nextCities);
    });
    return () => {
      cancelled = true;
    };
  }, [cities, preload]);

  return { cities, loadCities };
}
