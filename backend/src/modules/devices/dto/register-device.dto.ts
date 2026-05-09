import { RegisterDeviceRequest, type RegisterDeviceRequestT } from 'shared';

export class RegisterDeviceDto implements RegisterDeviceRequestT {
  static readonly schema = RegisterDeviceRequest;
  declare mac: string;
  declare name?: string;
}
