import type { HotListSource } from '../hot-list.types';
import { fetchText } from '../fetch';
import { compactHot, withRanks } from '../text';

const APOLLO_STATE_PREFIX = 'window.__APOLLO_STATE__=';

interface KuaishouHotItem {
  id?: string;
  name?: string;
  hotValue?: string;
  photoIds?: { json?: string[] };
  items?: Array<{ id?: string }>;
}

type KuaishouApolloState = Record<string, KuaishouHotItem>;

export const kuaishouSource: HotListSource = {
  id: 'kuaishou',
  label: '快手',
  async fetch(ctx) {
    const html = await fetchText('https://www.kuaishou.com/?isHome=1', { signal: ctx.signal });
    const start = html.indexOf(APOLLO_STATE_PREFIX);
    if (start === -1) throw new Error('快手页面结构变更');
    const scriptSlice = html.slice(start + APOLLO_STATE_PREFIX.length);
    const sentinelA = scriptSlice.indexOf(';(function(');
    const sentinelB = scriptSlice.indexOf('</script>');
    const cutIndex =
      sentinelA !== -1 && sentinelB !== -1
        ? Math.min(sentinelA, sentinelB)
        : Math.max(sentinelA, sentinelB);
    if (cutIndex === -1) throw new Error('快手数据结束标记缺失');
    const raw = scriptSlice.slice(0, cutIndex).trim().replace(/;$/, '');
    const json = JSON.parse(extractJsonObject(raw)) as {
      defaultClient?: KuaishouApolloState;
    };
    const state = json.defaultClient ?? {};
    const root =
      state['$ROOT_QUERY.visionHotRank({"page":"home"})'] ??
      state['$ROOT_QUERY.visionHotRank({"page":"home","platform":"web"})'];
    return withRanks(
      (root?.items ?? []).map((item) => {
        const hotItem = item.id ? state[item.id] : undefined;
        const videoId = hotItem?.photoIds?.json?.[0];
        return {
          title: hotItem?.name ?? '',
          hot: compactHot(hotItem?.hotValue),
          url: videoId ? `https://www.kuaishou.com/short-video/${videoId}` : undefined,
        };
      })
    );
  },
};

function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('快手数据 JSON 起始缺失');

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error('快手数据 JSON 结束缺失');
}
