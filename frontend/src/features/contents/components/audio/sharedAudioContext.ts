import { onSessionEnded } from '@/features/auth/lib/session-events';

export const CONTENT_AUDIO_SAMPLE_RATE = 16000;

let sharedAudioContext: AudioContext | null = null;
let unsubscribeSessionEnded: (() => void) | null = null;

export function ensureSharedAudioContextSessionCleanup(): void {
  unsubscribeSessionEnded ??= onSessionEnded(closeSharedAudioContext);
}

export function getSharedAudioContext(): AudioContext | null {
  if (typeof window === 'undefined' || typeof AudioContext === 'undefined') return null;
  ensureSharedAudioContextSessionCleanup();
  if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
    sharedAudioContext = new AudioContext({ sampleRate: CONTENT_AUDIO_SAMPLE_RATE });
  }
  return sharedAudioContext;
}

export async function resumeSharedAudioContext(): Promise<AudioContext | null> {
  const ctx = getSharedAudioContext();
  if (!ctx) return null;
  if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
    await ctx.resume();
  }
  return ctx;
}

export function closeSharedAudioContext(): void {
  const ctx = sharedAudioContext;
  sharedAudioContext = null;
  if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {});
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribeSessionEnded?.();
    unsubscribeSessionEnded = null;
    closeSharedAudioContext();
  });
}
