import { FONT_TEST_FONTS, FontTestFontId, type DynamicConfigT, type FontTestFontIdT } from 'shared';
import { Select, SelectItem } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import type { DynamicConfigChange } from '@/features/dynamic/types';

export function FontTestConfigPanel({
  config,
  onChange,
}: {
  config: Extract<DynamicConfigT, { type: 'font_test' }>;
  onChange: DynamicConfigChange;
}) {
  const selectedFont = FONT_TEST_FONTS.find((item) => item.id === config.font_id);

  return (
    <div className="space-y-4">
      <div>
        <p className="font-mono text-[10px] text-stone uppercase tracking-[0.18em] mb-1.5">字体</p>
        <Select
          value={config.font_id}
          onValueChange={(value) => {
            if (!isFontTestFontId(value)) return;
            onChange({ ...config, font_id: value });
          }}
        >
          {FONT_TEST_FONTS.map((option) => (
            <SelectItem key={option.id} value={option.id} hint={option.hint}>
              {option.label}
            </SelectItem>
          ))}
        </Select>
      </div>
      {selectedFont && (
        <div className="space-y-1.5">
          <p className="font-sans text-[12px] text-stone leading-relaxed italic">
            {selectedFont.note}
          </p>
          <p className="mt-1.5 font-mono text-[10px] text-stone truncate">
            {selectedFont.source} · {selectedFont.license}
          </p>
        </div>
      )}
      <Checkbox
        label="反白测试"
        checked={config.invert}
        onChange={(value) => onChange({ ...config, invert: value })}
      />
    </div>
  );
}

function isFontTestFontId(value: string): value is FontTestFontIdT {
  return FontTestFontId.safeParse(value).success;
}
