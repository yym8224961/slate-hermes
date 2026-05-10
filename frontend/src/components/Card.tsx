// Mono Press 卡片：0 圆角 + 墨线 1px 边框。

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../lib/cn';

interface CardProps {
  to?: string;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
  ribbon?: ReactNode;
}

export function Card({ to, onClick, children, className, ribbon }: CardProps) {
  const interactive = to || onClick;
  const inner = (
    <div
      className={cn('craft-card relative px-5 py-5 sm:px-6 sm:py-6', className)}
      data-hoverable={interactive ? 'true' : undefined}
    >
      {ribbon && <div className="absolute top-4 right-4">{ribbon}</div>}
      {children}
    </div>
  );
  if (to)
    return (
      <Link to={to} className="block">
        {inner}
      </Link>
    );
  if (onClick)
    return (
      <button onClick={onClick} className="block w-full text-left">
        {inner}
      </button>
    );
  return inner;
}
