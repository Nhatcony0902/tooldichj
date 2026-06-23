import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { buildVietQrUrl } from './vietqr.util';
import { generateOrderCode } from './order-code.util';
import {
  creditsForAmount,
  MAX_TOPUP_AMOUNT_VND,
  MIN_TOPUP_AMOUNT_VND,
} from './packages.config';

const ORDER_CODE_MAX_RETRIES = 5;

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService) {}

  async createTopupRequest(userId: string, amount: number) {
    if (
      !Number.isInteger(amount) ||
      amount < MIN_TOPUP_AMOUNT_VND ||
      amount > MAX_TOPUP_AMOUNT_VND
    ) {
      throw new BadRequestException(
        `Amount must be an integer between ${MIN_TOPUP_AMOUNT_VND} and ${MAX_TOPUP_AMOUNT_VND} VND`,
      );
    }

    const credits = creditsForAmount(amount);
    let lastError: unknown;

    for (let attempt = 0; attempt < ORDER_CODE_MAX_RETRIES; attempt++) {
      const orderCode = generateOrderCode();
      try {
        const request = await this.prisma.creditTopupRequest.create({
          data: { userId, amount, orderCode, status: 'PENDING' },
        });
        return {
          requestId: request.id,
          orderCode: request.orderCode,
          amount: request.amount,
          credits,
          status: request.status,
          qrUrl: buildVietQrUrl({
            amount: request.amount,
            orderCode: request.orderCode,
          }),
        };
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('Failed to create topup request');
  }

  async listMine(userId: string) {
    const requests = await this.prisma.creditTopupRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return requests.map((r) => ({
      ...r,
      credits: creditsForAmount(r.amount),
    }));
  }

  async listPending() {
    const requests = await this.prisma.creditTopupRequest.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { id: true, email: true, name: true } } },
    });
    return requests.map((r) => ({
      ...r,
      credits: creditsForAmount(r.amount),
    }));
  }

  async confirmRequest(requestId: string, adminUserId: string) {
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.creditTopupRequest.findUnique({
        where: { id: requestId },
      });
      if (!request) {
        throw new NotFoundException('Topup request not found');
      }

      // The WHERE clause below — not the read above — is what actually closes
      // the race: a plain read-then-write can let two concurrent confirms both
      // observe PENDING and both credit the user. Postgres row-locks during
      // this UPDATE, so only one concurrent call can ever flip status away
      // from PENDING; the loser's WHERE no longer matches (count === 0).
      const { count } = await tx.creditTopupRequest.updateMany({
        where: { id: requestId, status: 'PENDING' },
        data: { status: 'CONFIRMED', confirmedBy: adminUserId },
      });
      if (count === 0) {
        throw new ConflictException(
          `Request already ${request.status.toLowerCase()}`,
        );
      }

      const credits = creditsForAmount(request.amount);
      await tx.user.update({
        where: { id: request.userId },
        data: { credits: { increment: credits } },
      });

      return {
        ...request,
        status: 'CONFIRMED',
        confirmedBy: adminUserId,
        credits,
      };
    });
  }

  async rejectRequest(requestId: string, adminUserId: string) {
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.creditTopupRequest.findUnique({
        where: { id: requestId },
      });
      if (!request) {
        throw new NotFoundException('Topup request not found');
      }

      // Same atomic-WHERE gate as confirmRequest — see comment there.
      const { count } = await tx.creditTopupRequest.updateMany({
        where: { id: requestId, status: 'PENDING' },
        data: { status: 'REJECTED', confirmedBy: adminUserId },
      });
      if (count === 0) {
        throw new ConflictException(
          `Request already ${request.status.toLowerCase()}`,
        );
      }

      return { ...request, status: 'REJECTED', confirmedBy: adminUserId };
    });
  }
}
