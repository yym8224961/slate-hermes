import type { HotListSource } from './hot-list.types';
import { baiduSource } from './sources/baidu';
import { bilibiliSource } from './sources/bilibili';
import { douyinSource } from './sources/douyin';
import { hupuSource } from './sources/hupu';
import { ithomeSource } from './sources/ithome';
import { juejinSource } from './sources/juejin';
import { kuaishouSource } from './sources/kuaishou';
import { smzdmSource } from './sources/smzdm';
import { sspaiSource } from './sources/sspai';
import { thepaperSource } from './sources/thepaper';
import { tiebaSource } from './sources/tieba';
import { toutiaoSource } from './sources/toutiao';
import { v2exSource } from './sources/v2ex';
import { weiboSource } from './sources/weibo';
import { zhihuSource } from './sources/zhihu';
import { kr36Source } from './sources/36kr';
import { githubTrendingSource } from './sources/github-trending';
import { REFERENCE_HOT_LIST_SOURCES } from './reference-sources';

export const HOT_LIST_SOURCE_REGISTRY = [
  zhihuSource,
  weiboSource,
  baiduSource,
  v2exSource,
  bilibiliSource,
  toutiaoSource,
  thepaperSource,
  douyinSource,
  kuaishouSource,
  hupuSource,
  tiebaSource,
  juejinSource,
  sspaiSource,
  ithomeSource,
  smzdmSource,
  kr36Source,
  githubTrendingSource,
  ...REFERENCE_HOT_LIST_SOURCES,
] as const satisfies readonly HotListSource[];
