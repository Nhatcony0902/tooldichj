import { Module } from '@nestjs/common';
import { STORAGE_PROVIDER } from './storage.interface';
import { LocalDiskStorageProvider } from './local-disk.provider';

@Module({
  providers: [
    {
      provide: STORAGE_PROVIDER,
      useClass: LocalDiskStorageProvider,
    },
  ],
  exports: [STORAGE_PROVIDER],
})
export class StorageModule {}
