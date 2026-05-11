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
    <div className={cn('flex items-center gap-4', className)}>
      <IconBlock size="lg" tone="soft">{icon}</IconBlock>
      <div className="min-w-0 flex-1">
        <Dialog.Title className="font-serif text-[22px] font-bold leading-[1.2]">
          {title}
        </Dialog.Title>
        {description && (
          <Dialog.Description className="font-sans text-[13px] text-stone mt-1.5 leading-relaxed">
            {description}
          </Dialog.Description>
        )}
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
