import { Readable } from 'stream';

export const STORAGE_PROVIDER = 'STORAGE_PROVIDER';

export interface IStorageProvider {
  save(buffer: Buffer, key: string): Promise<void>;
  read(key: string): Promise<Buffer>;
  stream(key: string): Promise<Readable>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}
