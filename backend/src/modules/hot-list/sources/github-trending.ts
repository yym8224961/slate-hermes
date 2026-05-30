import { DESKTOP_UA } from '../fetch';
import { defineJsonSource } from '../source-factory';
import { compactHot } from '../text';

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

export const githubTrendingSource = defineJsonSource<GithubSearchResponse>({
  id: 'github-trending',
  label: 'GitHub',
  url: () => {
    const createdAfter = formatDate(daysAgo(7));
    const query = encodeURIComponent(`created:>${createdAfter} stars:>0`);
    return `https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=30`;
  },
  options: {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': DESKTOP_UA,
    },
  },
  map(json) {
    return (json.items ?? []).map((item) => ({
      title: item.full_name ?? '',
      desc: item.description ?? undefined,
      author: item.language ?? item.owner?.login,
      hot: compactHot(item.stargazers_count, ' stars'),
      timestamp: item.created_at,
      url: item.html_url,
    }));
  },
});

function daysAgo(days: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
