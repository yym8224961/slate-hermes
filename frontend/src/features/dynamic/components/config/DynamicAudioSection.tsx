import { TTS_VOICES, type DynamicConfigT, type TtsVoiceT } from 'shared';
import { Select, SelectItem } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
import type { AudioDynamicConfig } from '@/features/dynamic/types';

export function DynamicAudioSection({
  config,
  onChange,
}: {
  config: AudioDynamicConfig;
  onChange: (config: DynamicConfigT) => void;
}) {
  return (
    <div className="space-y-3">
      <Checkbox
        label="生成音频"
        checked={config.audio_enabled}
        onChange={(value) => onChange({ ...config, audio_enabled: value })}
      />
      <div>
        <p className="font-mono text-[10px] text-stone uppercase tracking-[0.18em] mb-1.5">音色</p>
        <Select
          value={config.audio_voice}
          onValueChange={(value) => onChange({ ...config, audio_voice: value as TtsVoiceT })}
          disabled={!config.audio_enabled}
        >
          {TTS_VOICES.map((voice) => (
            <SelectItem key={voice} value={voice}>
              {voice}
            </SelectItem>
          ))}
        </Select>
      </div>
    </div>
  );
}
