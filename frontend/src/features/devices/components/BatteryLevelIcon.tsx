import { Battery, BatteryFull, BatteryWarning, type LucideProps } from 'lucide-react';

export function BatteryLevelIcon({ level, ...props }: LucideProps & { level: number | null }) {
  if (level != null && level < 20) return <BatteryWarning {...props} />;
  if (level != null && level >= 80) return <BatteryFull {...props} />;
  return <Battery {...props} />;
}
