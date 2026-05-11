import { LoginRequest, type LoginRequestT } from 'shared';

export class LoginDto implements LoginRequestT {
  static readonly schema = LoginRequest;
  declare identifier: string;
  declare password: string;
}
