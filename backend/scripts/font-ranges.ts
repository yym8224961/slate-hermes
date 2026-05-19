#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

function toLvRange(token: string): string {
  const [start, end] = token.split('-');
  if (!start) throw new Error(`invalid charset token: ${token}`);
  const startHex = `0x${start}`;
  return end ? `${startHex}-0x${end}` : startHex;
}

const font = process.argv[2];
if (!font) {
  throw new Error('usage: bun backend/scripts/font-ranges.ts <font-file>');
}

const charset = execFileSync('fc-query', [`--format=%{charset}`, resolve(font)], {
  encoding: 'utf8',
});
const ranges = charset.trim().split(/\s+/).filter(Boolean).map(toLvRange);
process.stdout.write(ranges.join(','));
