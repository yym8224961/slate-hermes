import type { CurrentHotListSourceIdT } from 'shared';

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
  source: CurrentHotListSourceIdT;
  sourceLabel: string;
  updatedAt: string;
  items: HotListItem[];
}

export interface HotListSourceFetchCtx {
  signal: AbortSignal;
}

export interface HotListSource {
  id: CurrentHotListSourceIdT;
  label: string;
  fetch(ctx: HotListSourceFetchCtx): Promise<HotListItem[]>;
}

export interface NeteaseResponse {
  data?: {
    list?: Array<{
      docid?: string;
      skipID?: string;
      title?: string;
      _keyword?: string;
      source?: string;
      publishTime?: string;
      ptime?: string;
      url?: string;
    }>;
  };
}

export interface QqNewsResponse {
  idlist?: Array<{
    newslist?: Array<{
      id?: string;
      title?: string;
      abstract?: string;
      source?: string;
      timestamp?: number;
      readCount?: number;
      hotEvent?: { hotScore?: number };
    }>;
  }>;
}
