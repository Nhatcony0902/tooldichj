import { Injectable, Logger } from '@nestjs/common';
import { IStorageProvider } from './storage.interface';
import * as fs from 'fs/promises';
import { createReadStream } from 'fs';
import * as path from 'path';
import { Readable } from 'stream';

@Injectable()
export class LocalDiskStorageProvider implements IStorageProvider {
  private readonly logger = new Logger(LocalDiskStorageProvider.name);
  private readonly rootDir: string;

  constructor() {
    this.rootDir = process.env.STORAGE_ROOT_DIR || './storage';
  }

  private resolvePath(key: string): string {
    const root = path.resolve(this.rootDir);
    const resolved = path.resolve(root, key);
    // A plain startsWith(root) check is bypassable by a sibling directory
    // that merely shares the root as a string prefix (e.g. "root-evil").
    // Requiring an exact match or a path-separator boundary closes that.
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error('Path traversal attempt detected');
    }
    return resolved;
  }

  async save(buffer: Buffer, key: string): Promise<void> {
    const filePath = this.resolvePath(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, buffer);
    this.logger.log(`Saved file: ${key} (${buffer.length} bytes)`);
  }

  async read(key: string): Promise<Buffer> {
    return fs.readFile(this.resolvePath(key));
  }

  async stream(key: string): Promise<Readable> {
    const filePath = this.resolvePath(key);
    await fs.access(filePath);
    return createReadStream(filePath);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolvePath(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.resolvePath(key));
    } catch {
      this.logger.warn(`File not found for deletion: ${key}`);
    }
  }
}
