import { useEffect, useMemo, useState } from 'react';
import { SearchDropdown } from '@/components/ui/SearchDropdown';
import { searchCities } from '@/lib/cities';

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

  useEffect(() => {
    setQuery(value);
    setDirty(false);
    setOpen(false);
  }, [value]);

  const results = useMemo(
    () => (dirty && query.trim() ? searchCities(query.trim()).slice(0, 8) : []),
    [dirty, query]
  );

  useEffect(() => {
    if (results.length > 0) setOpen(true);
    else if (dirty) setOpen(false);
  }, [dirty, results.length]);

  const noResult = dirty && query.trim().length > 0 && results.length === 0;

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
      getKey={(result) => `${result.name}-${result.province}`}
      onSelect={(result) => {
        onSelect({ locationId: result.locationId, label: result.name });
        setQuery(result.name);
        setDirty(false);
      }}
      renderItem={(result) => (
        <>
          {result.name}
          {result.province !== result.name && (
            <span className="ml-2 text-stone text-[11px]">{result.province}</span>
          )}
        </>
      )}
      noResult={
        noResult ? (
          <p className="font-sans text-[11px] text-stone mt-1.5">未找到此城市，支持省份名搜索</p>
        ) : null
      }
    />
  );
}
