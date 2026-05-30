#!/usr/bin/env bun
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { FRAME_HEIGHT, FRAME_WIDTH } from 'shared';
import type { ContentDetailT, DitherMode, TtsVoiceT } from 'shared';
import { API_DEFAULT_DITHER_MODE, DITHER_MODES, DEFAULT_TTS_VOICE, isTtsVoice } from 'shared';
import type { ContentsReadService } from '../src/modules/contents/contents-read.service';
import type { ContentsService } from '../src/modules/contents/contents.service';
import type { ParsedContentUpload } from '../src/modules/contents/multipart.parser';
import {
  createGroupScriptServices,
  deleteAllContents,
  ensureGroup,
  readArgValue,
  resolveUser,
  userDisplay,
  type UserSelectorArgs,
} from './helpers/bootstrap-app';

interface Args extends UserSelectorArgs {
  groupName: string;
  sourceDir: string;
  replace: boolean;
  voice: TtsVoiceT;
  mode: DitherMode;
  threshold?: number;
}

interface VehicleFrame {
  seq: number;
  name: string;
  filename: string;
  text: string;
}

const STATUS_BAR_HEIGHT = 24;
const SAFE_SIDE = 8;
const VISIBLE_HEIGHT = FRAME_HEIGHT - STATUS_BAR_HEIGHT;
const VISIBLE_TOP_PAD = 18;
const VISIBLE_BOTTOM_PAD = 4;
const CONTENT_THRESHOLD = 248;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE_DIR = join(SCRIPT_DIR, '../assets/vehicles');

const VEHICLES: VehicleFrame[] = [
  { seq: 1, name: '挖掘机', filename: '01-excavator.png', text: '挖掘机，挖呀挖。轰隆隆！' },
  { seq: 2, name: '铲车', filename: '02-loader.png', text: '铲车铲沙子。哐当！' },
  { seq: 3, name: '水泥罐车', filename: '03-cement-mixer.png', text: '水泥车，转一转。咕噜噜！' },
  { seq: 4, name: '翻斗车', filename: '04-dump-truck.png', text: '翻斗车，倒泥土。哗啦！' },
  { seq: 5, name: '吊车', filename: '05-crane.png', text: '吊车吊得高。吱呀——！' },
  { seq: 6, name: '警车', filename: '06-police-car.png', text: '警察警察，让一让！呜哇呜哇！' },
  { seq: 7, name: '救护车', filename: '07-ambulance.png', text: '救护车，去医院。嘀嘟嘀嘟！' },
  { seq: 8, name: '消防车', filename: '08-fire-truck.png', text: '消防车救火啦！呜——！' },
  { seq: 9, name: '洒水车', filename: '09-sprinkler-truck.png', text: '洒水车，洒洒水。哗——！' },
  { seq: 10, name: '垃圾车', filename: '10-garbage-truck.png', text: '垃圾车，吃垃圾。咕噜！' },
  { seq: 11, name: '巴士', filename: '11-bus.png', text: '巴士，到站啦。叮咚！' },
  { seq: 12, name: '出租车', filename: '12-taxi.png', text: '出租车，请上车。嘀！' },
];

const args = parseArgs(process.argv.slice(2));
const services = await createGroupScriptServices();

try {
  const { prisma, groups, contents, contentReads } = services;
  const user = await resolveUser(prisma, args);
  const group = await ensureGroup(groups, prisma, user.id, args.groupName);

  if (args.replace) {
    await deleteAllContents(contents, contentReads, group.id, user.id);
  } else {
    await deleteDuplicateVehicleFrames(contents, contentReads, group.id, user.id);
  }

  const generated = await upsertVehicleFrames(contents, contentReads, group.id, user.id, args);
  const finalRows = await contentReads.list(group.id, { userId: user.id });
  const orderedIds = orderedContentIds(finalRows);
  const { manifest_etag } = await contents.reorder(group.id, user.id, orderedIds);

  process.stdout.write(
    [
      `Vehicle group ready: ${args.groupName}`,
      `  user: ${userDisplay(user)}`,
      `  group_id: ${group.id}`,
      `  frames: ${generated.length}`,
      `  voice: ${args.voice}`,
      `  source_dir: ${args.sourceDir}`,
      `  manifest_etag: ${manifest_etag}`,
    ].join('\n') + '\n'
  );
} finally {
  await services.app.close();
}
process.exit(0);

function parseArgs(argv: string[]): Args {
  const args: Args = {
    groupName: '工程车',
    sourceDir: DEFAULT_SOURCE_DIR,
    replace: false,
    voice: DEFAULT_TTS_VOICE,
    mode: API_DEFAULT_DITHER_MODE,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--replace') {
      args.replace = true;
    } else if (arg === '--user-id') {
      args.userId = readArgValue(argv, ++i, arg);
    } else if (arg === '--email') {
      args.email = readArgValue(argv, ++i, arg);
    } else if (arg === '--username') {
      args.username = readArgValue(argv, ++i, arg);
    } else if (arg === '--group-name') {
      args.groupName = readArgValue(argv, ++i, arg);
    } else if (arg === '--source-dir') {
      args.sourceDir = readArgValue(argv, ++i, arg);
    } else if (arg === '--voice') {
      args.voice = readVoice(readArgValue(argv, ++i, arg), arg);
    } else if (arg === '--mode') {
      args.mode = readDitherMode(readArgValue(argv, ++i, arg), arg);
    } else if (arg === '--threshold') {
      args.threshold = readThreshold(readArgValue(argv, ++i, arg), arg);
    } else if (arg === '--help' || arg === '-h') {
      printHelpAndExit();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function readVoice(value: string, flag: string): TtsVoiceT {
  if (!isTtsVoice(value)) {
    throw new Error(`${flag} must be one of: 冰糖, 茉莉, 苏打, 白桦, Mia, Chloe, Milo, Dean`);
  }
  return value;
}

function readDitherMode(value: string, flag: string): DitherMode {
  if (!(DITHER_MODES as readonly string[]).includes(value)) {
    throw new Error(`${flag} must be one of: ${DITHER_MODES.join(', ')}`);
  }
  return value as DitherMode;
}

function readThreshold(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 255) {
    throw new Error(`${flag} requires an integer from 0 to 255`);
  }
  return n;
}

function printHelpAndExit(): never {
  process.stdout.write(`Usage:
  bun run scripts/create-vehicle-group.ts [--email <email> | --username <name> | --user-id <id>]

Options:
  --group-name <name>  Group name to create or update. Default: 工程车
  --source-dir <path>  Directory containing vehicle PNG files. Default: assets/vehicles
  --replace            Delete all existing contents in the target group before creating frames.
  --voice <voice>      TTS voice. Default: ${DEFAULT_TTS_VOICE}
  --mode <mode>        Dither mode. Default: ${API_DEFAULT_DITHER_MODE}
  --threshold <0-255>  Optional black/white threshold.
`);
  process.exit(0);
}

async function deleteDuplicateVehicleFrames(
  contents: ContentsService,
  contentReads: ContentsReadService,
  groupId: string,
  userId: string
): Promise<void> {
  const rows = await contentReads.list(groupId, { userId });
  const seen = new Set<string>();
  const valid = new Set(VEHICLES.map((vehicle) => vehicle.name));

  for (const row of rows) {
    const name = row.frame_name;
    if (!name || !valid.has(name)) continue;
    if (row.kind !== 'image' || seen.has(name)) {
      await contents.delete(row.id, userId);
      continue;
    }
    seen.add(name);
  }
}

async function upsertVehicleFrames(
  contents: ContentsService,
  contentReads: ContentsReadService,
  groupId: string,
  userId: string,
  args: Args
): Promise<Array<{ name: string; contentId: string }>> {
  const rows = await contentReads.list(groupId, { userId });
  const byName = new Map<string, ContentDetailT>();
  for (const row of rows) {
    if (row.kind === 'image' && row.frame_name) byName.set(row.frame_name, row);
  }

  const generated: Array<{ name: string; contentId: string }> = [];
  for (const vehicle of VEHICLES) {
    const imageBuf = await prepareVehicleImage(
      await readFile(join(args.sourceDir, vehicle.filename))
    );
    const parsed = uploadForVehicle(vehicle.name, imageBuf, args);
    const existing = byName.get(vehicle.name);
    const result = existing
      ? await contents.patchImage(existing.id, userId, parsed)
      : await contents.appendImage(groupId, userId, parsed);

    await contents.generateImageTts(result.id, userId, {
      text: vehicle.text,
      voice: args.voice,
    });
    generated.push({ name: vehicle.name, contentId: result.id });
  }
  return generated;
}

async function prepareVehicleImage(input: Buffer): Promise<Buffer> {
  const source = sharp(input).flatten({ background: { r: 255, g: 255, b: 255 } });
  const { data, info } = await source
    .clone()
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bbox = contentBounds(data, info.width, info.height, CONTENT_THRESHOLD);
  const cropped = bbox
    ? source.clone().extract({ left: bbox.x, top: bbox.y, width: bbox.w, height: bbox.h })
    : source.clone();

  const resized = await cropped
    .resize(FRAME_WIDTH - SAFE_SIDE * 2, VISIBLE_HEIGHT - VISIBLE_TOP_PAD - VISIBLE_BOTTOM_PAD, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255 },
      withoutEnlargement: false,
    })
    .png()
    .toBuffer({ resolveWithObject: true });

  const left = Math.round((FRAME_WIDTH - resized.info.width) / 2);
  const top =
    STATUS_BAR_HEIGHT +
    VISIBLE_TOP_PAD +
    Math.round((VISIBLE_HEIGHT - VISIBLE_TOP_PAD - VISIBLE_BOTTOM_PAD - resized.info.height) / 2);

  return sharp({
    create: {
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([{ input: resized.data, left, top }])
    .png()
    .toBuffer();
}

function contentBounds(
  gray: Buffer,
  width: number,
  height: number,
  threshold: number
): { x: number; y: number; w: number; h: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (gray[row + x]! >= threshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) return null;
  return {
    x: minX,
    y: minY,
    w: maxX - minX + 1,
    h: maxY - minY + 1,
  };
}

function uploadForVehicle(name: string, imageBuf: Buffer, args: Args): ParsedContentUpload {
  return {
    hasImage: true,
    imageBuf,
    hasAudio: false,
    audioBuf: null,
    hasFrameName: true,
    frameName: name,
    mode: args.mode,
    threshold: args.threshold,
  };
}

function orderedContentIds(rows: ContentDetailT[]): string[] {
  const rank = new Map<string, number>(VEHICLES.map((vehicle, index) => [vehicle.name, index]));
  const vehicleRows = rows
    .filter((row) => row.kind === 'image' && row.frame_name && rank.has(row.frame_name))
    .sort((a, b) => rank.get(a.frame_name!)! - rank.get(b.frame_name!)!);
  const otherRows = rows
    .filter((row) => !(row.kind === 'image' && row.frame_name && rank.has(row.frame_name)))
    .sort((a, b) => a.seq - b.seq);
  return [...vehicleRows, ...otherRows].map((row) => row.id);
}
