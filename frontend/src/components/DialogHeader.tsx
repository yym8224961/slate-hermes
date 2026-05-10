import type { ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { IconBlock } from './IconBlock';
import { cn } from '../lib/cn';

interface DialogHeaderProps {
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  onClose?: () => void;
  className?: string;
}

export function DialogHeader({ icon, title, description, onClose, className }: DialogHeaderProps) {
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="flex items-start gap-3 min-w-0">
        <IconBlock tone="soft">{icon}</IconBlock>
        <div className="min-w-0">
          <Dialog.Title className="font-serif text-[22px] font-bold leading-tight">
            {title}
          </Dialog.Title>
          {description && (
            <Dialog.Description className="font-sans text-[13px] text-stone mt-1 leading-relaxed">
              {description}
            </Dialog.Description>
          )}
        </div>
      </div>
      <Dialog.Close asChild>
        <button
          aria-label="关闭"
          onClick={onClose}
          className="p-1.5 -m-1.5 text-stone hover:text-ink hover:bg-cream flex-shrink-0 transition-colors"
        >
          <X size={18} />
        </button>
      </Dialog.Close>
    </div>
  );
}
