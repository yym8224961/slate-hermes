import type { Prisma } from '@prisma/client';

export function resetAudioFields(now = new Date()) {
  return {
    audioEtag: null,
    audioSize: null,
    audioStatus: 'none' as const,
    audioSource: null,
    audioVoice: null,
    audioText: null,
    audioLastError: null,
    audioUpdatedAt: now,
    audioLeaseUntil: null,
    audioAttempts: 0,
  };
}

export function pendingTtsAudioFields(
  text: string,
  voice: string,
  now = new Date()
): Prisma.ContentUpdateInput {
  return {
    audioEtag: null,
    audioSize: null,
    audioStatus: 'pending',
    audioSource: 'tts',
    audioVoice: voice,
    audioText: text,
    audioLastError: null,
    audioUpdatedAt: now,
    audioLeaseUntil: null,
    audioAttempts: 0,
  };
}

export function readyUploadedAudioFields(etag: string, size: number, now = new Date()) {
  return {
    audioEtag: etag,
    audioSize: size,
    audioStatus: 'ready' as const,
    audioSource: 'upload' as const,
    audioVoice: null,
    audioText: null,
    audioLastError: null,
    audioUpdatedAt: now,
    audioLeaseUntil: null,
    audioAttempts: 0,
  };
}
