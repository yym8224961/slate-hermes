import { ArrowUp } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Button } from './Button';
import { Spinner } from './Spinner';

interface FormActionsProps {
  onCancel: () => void;
  onSubmit: () => void;
  submitLabel: string;
  submitting?: boolean;
  disabled?: boolean;
  className?: string;
  cancelLabel?: string;
  submitIcon?: ReactNode;
}

export function FormActions({
  onCancel,
  onSubmit,
  submitLabel,
  submitting = false,
  disabled = false,
  className,
  cancelLabel = '取消',
  submitIcon = <ArrowUp size={16} />,
}: FormActionsProps) {
  return (
    <div
      className={cn(
        'flex gap-3 pt-6 border-t border-line sticky bottom-0 bg-paper pb-6',
        className
      )}
    >
      <Button variant="outline" onClick={onCancel} className="flex-1">
        {cancelLabel}
      </Button>
      <Button
        onClick={onSubmit}
        disabled={disabled || submitting}
        iconLeft={!submitting ? submitIcon : undefined}
        className="flex-1"
      >
        {submitting ? <Spinner /> : submitLabel}
      </Button>
    </div>
  );
}
