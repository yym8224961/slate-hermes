import { SelectGroupByDeviceRequest, type SelectGroupByDeviceRequestT } from 'shared';

export class SelectGroupByDeviceDto implements SelectGroupByDeviceRequestT {
  static readonly schema = SelectGroupByDeviceRequest;
  declare id: string;
}
