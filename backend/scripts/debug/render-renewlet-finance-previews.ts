#!/usr/bin/env bun
import { mkdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import sharp from 'sharp';
import { DashboardTemplate, FRAME_HEIGHT, FRAME_WIDTH } from 'shared';
import { DynamicFrameRendererService } from '../../src/modules/dynamic-content/rendering/dynamic-frame-renderer.service';
import { DynamicFrameFontService } from '../../src/modules/dynamic-content/rendering/fonts/dynamic-frame-font.service';

const outputDirectory = process.argv[2] ?? '/private/tmp/slate-renewlet-finance-previews';
const templateDirectory = resolve(
  import.meta.dir,
  '../../../tools/renewlet-finance-dashboard/templates'
);
const renderer = new DynamicFrameRendererService(new DynamicFrameFontService());
const fixtures = [
  ['monthly-cashflow-template.json', 'monthly-cashflow-initial-data.json'],
  ['recent-expenses-template.json', 'recent-expenses-initial-data.json'],
] as const;

await mkdir(outputDirectory, { recursive: true });

for (const [templateName, dataName] of fixtures) {
  const template = DashboardTemplate.parse(
    JSON.parse(await readFile(join(templateDirectory, templateName), 'utf8'))
  );
  const envelope = JSON.parse(await readFile(join(templateDirectory, dataName), 'utf8')) as {
    data: Record<string, unknown>;
  };
  const frame = await renderer.render({
    type: 'dashboard',
    frameName: template.name ?? 'Renewlet 财务',
    config: { type: 'dashboard', template: { kind: 'custom', template } },
    data: envelope.data,
    renderedAt: new Date('2026-08-29T17:15:00.000Z'),
  });
  const outputPath = join(outputDirectory, `${basename(templateName, '.json')}.png`);
  await sharp(unpack1bpp(frame), {
    raw: { width: FRAME_WIDTH, height: FRAME_HEIGHT, channels: 1 },
  })
    .resize(FRAME_WIDTH * 2, FRAME_HEIGHT * 2, { kernel: 'nearest' })
    .png()
    .toFile(outputPath);
  process.stdout.write(`${outputPath}\n`);
}

function unpack1bpp(frame: Buffer): Buffer {
  const output = Buffer.alloc(FRAME_WIDTH * FRAME_HEIGHT);
  const bytesPerRow = FRAME_WIDTH >> 3;
  for (let y = 0; y < FRAME_HEIGHT; y += 1) {
    for (let x = 0; x < FRAME_WIDTH; x += 1) {
      const byte = frame[y * bytesPerRow + (x >> 3)]!;
      const bit = (byte >> (7 - (x & 7))) & 1;
      output[y * FRAME_WIDTH + x] = bit ? 255 : 0;
    }
  }
  return output;
}
