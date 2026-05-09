import { PatchDeviceRequest, type PatchDeviceRequestT } from 'shared';

export class PatchDeviceDto implements PatchDeviceRequestT {
  static readonly schema = PatchDeviceRequest;
  declare name?: string;
  declare selected_group_id?: string | null;
}
