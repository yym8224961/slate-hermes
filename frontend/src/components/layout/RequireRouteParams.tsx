import { useParams } from 'react-router-dom';
import { EmptyState } from '@/components/ui/EmptyState';

type Params = Record<string, string>;

export function RequireRouteParams<const Keys extends readonly string[]>({
  names,
  title = '页面不存在',
  hint,
  action,
  children,
}: {
  names: Keys;
  title?: string;
  hint?: string;
  action?: React.ReactNode;
  children: (params: { [Key in Keys[number]]: string }) => React.ReactNode;
}) {
  const params = useParams();
  const missing = names.some((name) => !params[name]);

  if (missing) {
    return <EmptyState title={title} hint={hint} action={action} />;
  }

  return <>{children(params as Params as { [Key in Keys[number]]: string })}</>;
}
