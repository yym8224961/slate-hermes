import type { HotListSourceIdT } from 'shared';

export interface HotListItem {
  rank: number;
  title: string;
  hot?: string;
  desc?: string;
  author?: string;
  url?: string;
  timestamp?: string;
}

export interface HotListProviderData {
  source: HotListSourceIdT;
  sourceLabel: string;
  updatedAt: string;
  items: HotListItem[];
}

export interface HotListSourceFetchCtx {
  signal: AbortSignal;
}

export interface HotListSource {
  id: HotListSourceIdT;
  label: string;
  fetch(ctx: HotListSourceFetchCtx): Promise<HotListItem[]>;
}
