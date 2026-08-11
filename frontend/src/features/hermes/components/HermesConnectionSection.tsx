import { Cable, Copy, ExternalLink, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Section } from '@/components/layout/Section';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/feedback/toast-context';
import { useTimeAgo } from '@/hooks/useTimeAgo';
import { cn } from '@/lib/cn';
import { useHermesStatus } from '@/features/hermes/query/hermes-queries';

const PLUGIN_URL = 'https://github.com/yym8224961/slate-hermes/tree/master/plugins/platforms/slate';

export function HermesConnectionSection() {
  const status = useHermesStatus();
  const toast = useToast();
  const slateBackend = window.location.origin.replace(/\/+$/, '');
  const lastSeenAgo = useTimeAgo(status.data?.last_seen_at ?? null, 15_000);
  const state = connectionState(status.data, status.isPending, status.isError, lastSeenAgo);
  const configTemplate = buildConfigTemplate(slateBackend);

  const copy = async (value: string, label: string) => {
    try {
      await copyText(value);
      toast.success(`${label}已复制`);
    } catch {
      toast.error('复制失败', '请选中文字后手动复制。');
    }
  };

  return (
    <Section
      title="Hermes 接入"
      badge={<Cable size={20} />}
      subtitle="让 Hermes Gateway 接收墨水屏语音，并使用现有的人格、记忆和工具回答"
      action={
        <Button
          variant="outline"
          size="sm"
          iconLeft={<RefreshCw size={14} className={cn(status.isFetching && 'animate-spin')} />}
          disabled={status.isFetching}
          onClick={() => void status.refetch()}
        >
          检查连接
        </Button>
      }
    >
      <div className="craft-card fade-up fade-up-1">
        <div className="flex flex-col gap-3 border-b border-ink px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-start gap-3">
            <span className={cn('dot mt-2 flex-shrink-0', state.dotClass)} aria-hidden="true" />
            <div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h3 className="font-serif text-[20px] font-bold leading-tight text-ink">
                  {state.title}
                </h3>
                <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-stone">
                  Gateway → Slate
                </span>
              </div>
              <p className="mt-1 font-sans text-[12px] leading-relaxed text-stone">
                {state.description}
              </p>
            </div>
          </div>
          <a
            href={PLUGIN_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex flex-shrink-0 items-center gap-1.5 self-start font-sans text-[11px] uppercase tracking-[0.16em] text-ink underline decoration-ink/30 underline-offset-4 hover:decoration-ink sm:self-center"
          >
            打开 Slate 插件
            <ExternalLink size={12} />
          </a>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2">
          <ConnectionPanel
            index="01"
            label="Slate 接入地址"
            description="在 Hermes 端填入这个地址。它就是你当前打开的 NAS 管理端地址。"
            copyLabel="接入地址"
            copyValue={slateBackend}
            onCopy={copy}
          >
            <code className="block break-all font-mono text-[13px] leading-relaxed text-ink">
              {slateBackend}
            </code>
          </ConnectionPanel>

          <ConnectionPanel
            index="02"
            label="两侧环境变量"
            description="同一个共享 Token 分别填入 Slate Docker 与 Hermes Gateway，网页不会读取或显示它。"
            copyLabel="配置模板"
            copyValue={configTemplate}
            onCopy={copy}
            className="border-t border-ink lg:border-l lg:border-t-0"
          >
            <div className="space-y-2 font-mono text-[11px] leading-relaxed">
              <ConfigRow name="Slate Docker" value="HERMES_AGENT_TOKEN" />
              <ConfigRow name="Hermes Gateway" value="SLATE_BACKEND · SLATE_AGENT_TOKEN" />
            </div>
          </ConnectionPanel>
        </div>

        <div className="border-t border-ink bg-cream/40 px-5 py-4 sm:px-6">
          <ol className="grid grid-cols-1 gap-3 text-[12px] leading-relaxed text-stone md:grid-cols-3 md:gap-6">
            <SetupStep
              index="1"
              text="用 openssl rand -hex 32 生成共享 Token，写入 Slate 的 .env。"
            />
            <SetupStep
              index="2"
              text="把 platforms/slate 插件安装到 Hermes，并执行 hermes plugins enable platforms/slate。"
            />
            <SetupStep
              index="3"
              text="在 Hermes 设置 SLATE_BACKEND 与 SLATE_AGENT_TOKEN，随后重启 Gateway。"
            />
          </ol>
        </div>
      </div>
    </Section>
  );
}

function ConnectionPanel({
  index,
  label,
  description,
  copyLabel,
  copyValue,
  onCopy,
  className,
  children,
}: {
  index: string;
  label: string;
  description: string;
  copyLabel: string;
  copyValue: string;
  onCopy: (value: string, label: string) => Promise<void>;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn('px-5 py-5 sm:px-6', className)}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-stone">
            {index} / {label}
          </p>
          <p className="mt-2 max-w-md font-sans text-[12px] leading-relaxed text-stone">
            {description}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void onCopy(copyValue, copyLabel)}
          aria-label={`复制${copyLabel}`}
          title={`复制${copyLabel}`}
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center border border-ink text-ink transition-colors hover:bg-cream-deep"
        >
          <Copy size={13} />
        </button>
      </div>
      <div className="mt-4 border-l-2 border-ink bg-cream/60 px-4 py-3">{children}</div>
    </section>
  );
}

function ConfigRow({ name, value }: { name: string; value: string }) {
  return (
    <div>
      <span className="text-stone">{name}</span>
      <span className="mx-2 text-stone-light">→</span>
      <span className="break-words text-ink">{value}</span>
    </div>
  );
}

function SetupStep({ index, text }: { index: string; text: string }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center bg-ink font-mono text-[10px] text-paper">
        {index}
      </span>
      <span>{text}</span>
    </li>
  );
}

function connectionState(
  status: { enabled: boolean; connected: boolean } | undefined,
  isPending: boolean,
  isError: boolean,
  lastSeenAgo: string
): { title: string; description: string; dotClass: string } {
  if (isPending) {
    return {
      title: '正在读取接入状态',
      description: '正在检查 Slate 后端与 Hermes Gateway 的最近连接。',
      dotClass: 'dot-offline',
    };
  }
  if (isError || !status) {
    return {
      title: '状态读取失败',
      description: '接入说明仍可使用；稍后点击“检查连接”重试。',
      dotClass: 'dot-warn',
    };
  }
  if (!status.enabled) {
    return {
      title: 'Hermes 尚未启用',
      description: '先在 Slate Docker 的 .env 中设置 HERMES_AGENT_TOKEN，并重建容器。',
      dotClass: 'dot-offline',
    };
  }
  if (status.connected) {
    return {
      title: 'Hermes 已连接',
      description: `Gateway 最近一次有效长轮询在 ${lastSeenAgo}。`,
      dotClass: 'dot-online',
    };
  }
  return {
    title: '等待 Hermes 连接',
    description: 'Slate 已启用共享 Token，但还没有检测到 Gateway 的有效长轮询。',
    dotClass: 'dot-warn',
  };
}

function buildConfigTemplate(slateBackend: string): string {
  return [
    '# Slate Docker .env',
    'HERMES_AGENT_TOKEN=<至少 32 字符的共享 Token>',
    '',
    '# Hermes Gateway',
    `SLATE_BACKEND=${slateBackend}`,
    'SLATE_AGENT_TOKEN=<与上方相同的共享 Token>',
  ].join('\n');
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('copy failed');
}
