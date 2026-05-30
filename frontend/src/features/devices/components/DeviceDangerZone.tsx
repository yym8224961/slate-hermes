import { Unlink } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';

export function DeviceDangerZone({
  pending,
  onUnbind,
}: {
  pending: boolean;
  onUnbind: () => void;
}) {
  return (
    <section className="pt-2">
      <Button
        variant="danger"
        size="sm"
        iconLeft={<Unlink size={14} />}
        onClick={onUnbind}
        disabled={pending}
      >
        {pending ? <Spinner /> : '从账号解绑'}
      </Button>
      <p className="font-serif text-[11px] italic text-stone-light mt-2">
        解绑后设备脱离你的账号，素材保留；重新添加可恢复。
      </p>
    </section>
  );
}
