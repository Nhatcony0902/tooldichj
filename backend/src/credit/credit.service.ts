import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { InsufficientCreditsError } from './insufficient-credits.error';

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

  async reserveCredit(userId: string, amount: number): Promise<void> {
    const result = await this.prisma.user.updateMany({
      where: { id: userId, credits: { gte: amount } },
      data: { credits: { decrement: amount } },
    });
    if (result.count === 0) {
      throw new InsufficientCreditsError(
        `Tài khoản cần có ít nhất ${amount} credits để thực hiện thao tác này!`,
      );
    }
    this.logger.log(`Reserved ${amount} credit(s) for user: ${userId}`);
  }

  async refundCredit(userId: string, amount: number): Promise<void> {
    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: { credits: { increment: amount } },
      });
      this.logger.log(`Refunded ${amount} credit(s) to user: ${userId}`);
    } catch (err) {
      this.logger.error(`Failed to refund credits for user ${userId}:`, err);
    }
  }
}
