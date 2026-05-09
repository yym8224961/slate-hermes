import { LoginRequest, type LoginRequestT } from 'shared';

export class LoginDto implements LoginRequestT {
  static readonly schema = LoginRequest;
  declare email: string;
  declare password: string;
}
