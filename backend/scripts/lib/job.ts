export interface SlateJob {
  id: string;
  description: string;
  run(): Promise<void>;
}
