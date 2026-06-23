import { Module } from '@nestjs/common';
import { CreditService } from './credit.service';
import { PrismaService } from '../prisma.service';

@Module({
  providers: [CreditService, PrismaService],
  exports: [CreditService],
})
export class CreditModule {}
