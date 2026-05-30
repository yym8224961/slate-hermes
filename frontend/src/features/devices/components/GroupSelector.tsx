import type { GroupSummaryT } from 'shared';
import { Select, SelectItem, SelectSeparator } from '@/components/ui/Select';

interface GroupSelectorProps {
  groups: GroupSummaryT[];
  value: string | null;
  onChange: (value: string) => void;
  disabled: boolean;
}

export function GroupSelector({ groups, value, onChange, disabled }: GroupSelectorProps) {
  const showNone = value === null;
  return (
    <Select
      value={value ?? '__none__'}
      onValueChange={onChange}
      disabled={disabled}
      placeholder="未选组"
      aria-label="切换在播组"
    >
      {showNone && <SelectItem value="__none__">未选组</SelectItem>}
      {showNone && groups.length > 0 && <SelectSeparator />}
      {groups.map((group) => (
        <SelectItem key={group.id} value={group.id} hint={`${group.content_count} 项`}>
          <span className="font-serif">{group.name}</span>
        </SelectItem>
      ))}
    </Select>
  );
}
