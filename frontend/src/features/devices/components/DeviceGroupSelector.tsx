import { Radio } from 'lucide-react';
import type { GroupSummaryT } from 'shared';
import { GroupSelector } from './GroupSelector';

export function DeviceGroupSelector({
  groups,
  value,
  onChange,
  disabled,
}: {
  groups: GroupSummaryT[];
  value: string | null;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-2 text-stone">
        <Radio size={14} />
        <h3 className="font-sans text-[12px] uppercase tracking-wide">在播</h3>
      </div>
      <GroupSelector groups={groups} value={value} onChange={onChange} disabled={disabled} />
      <p className="font-serif text-[12px] italic text-stone-light mt-2">
        切换后会立即向设备入队同步动作。
      </p>
    </section>
  );
}
