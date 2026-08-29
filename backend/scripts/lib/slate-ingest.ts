import { IngestPayload, type DashboardDataPayloadT, type IngestResponseT } from 'shared';
import { createScriptLogger } from '../helpers/script-logger';
import { getJSON, postJSON } from './http';
import { stripTrailingSlash } from './env';

const logger = createScriptLogger('SlateIngest');

export async function pushDashboardData(input: {
  slateAPIBase: string;
  contentID: string;
  data: DashboardDataPayloadT;
}): Promise<IngestResponseT> {
  const payload = IngestPayload.parse({ version: 1, data: input.data });
  const url = `${stripTrailingSlash(input.slateAPIBase)}/api/v1/contents/${input.contentID}/data`;
  const result = await postJSON<IngestResponseT>(url, payload, 'Slate push');

  logger.info('Slate accepted dashboard data push.');

  return result;
}

export async function pushDashboardDataAndVerify(input: {
  slateAPIBase: string;
  contentID: string;
  data: DashboardDataPayloadT;
}): Promise<IngestResponseT> {
  const result = await pushDashboardData(input);
  const url = `${stripTrailingSlash(input.slateAPIBase)}/api/v1/contents/${input.contentID}/data`;
  const readback = await getJSON<Record<string, unknown> | null>(url, 'Slate readback');
  if (stableJSON(readback) !== stableJSON(input.data)) {
    throw new Error('Slate dashboard readback did not match the data that was pushed.');
  }
  logger.info('Slate dashboard GET readback matched the pushed data.');
  return result;
}

function stableJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJSON(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
