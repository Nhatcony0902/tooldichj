import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class CreditService {
  private readonly logger = new Logger(CreditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async deductCredit(userId: string, amount: number): Promise<void> {
    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: { credits: { decrement: amount } },
      });
      this.logger.log(`Deducted ${amount} credit(s) from user: ${userId}`);
    } catch (err) {
      this.logger.error(`Failed to deduct credits for user ${userId}:`, err);
    }
  }
}
