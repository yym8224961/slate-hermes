import { RegisterRequest, type RegisterRequestT } from 'shared';

export class RegisterDto implements RegisterRequestT {
  static readonly schema = RegisterRequest;
  declare email: string;
  declare username: string;
  declare password: string;
}
