import { z } from 'zod';

export const ListDevicesQuery = z.object({
  owner: z.enum(['me', 'none']).optional(),
});
export type ListDevicesQueryT = z.infer<typeof ListDevicesQuery>;

export class ListDevicesQueryDto implements ListDevicesQueryT {
  static readonly schema = ListDevicesQuery;
  declare owner?: 'me' | 'none';
}
