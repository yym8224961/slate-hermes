export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  readonly detail?: unknown;

  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.detail = detail;
  }
}
