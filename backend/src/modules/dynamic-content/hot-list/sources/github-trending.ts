import type { HotListSource } from '../hot-list.types';
import { DESKTOP_UA, fetchJson } from '../fetch';
import { compactHot, withRanks } from '../text';

interface GithubSearchResponse {
  items?: Array<{
    full_name?: string;
    html_url?: string;
    description?: string | null;
    language?: string | null;
    stargazers_count?: number;
    owner?: { login?: string };
    created_at?: string;
  }>;
}

export const githubTrendingSource: HotListSource = {
  id: 'github-trending',
  label: 'GitHub',
  async fetch(ctx) {
    const createdAfter = formatDate(daysAgo(7));
    const query = encodeURIComponent(`created:>${createdAfter} stars:>0`);
    const json = await fetchJson<GithubSearchResponse>(
      `https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=30`,
      {
        signal: ctx.signal,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': DESKTOP_UA,
        },
      }
    );
    return withRanks(
      (json.items ?? []).map((item) => ({
        title: item.full_name ?? '',
        desc: item.description ?? undefined,
        author: item.language ?? item.owner?.login,
        hot: compactHot(item.stargazers_count, ' stars'),
        timestamp: item.created_at,
        url: item.html_url,
      }))
    );
  },
};

function daysAgo(days: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
