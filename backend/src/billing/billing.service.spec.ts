import { ConflictException, NotFoundException } from '@nestjs/common';
import { BillingService } from './billing.service';

// Models the one correctness property a unit test *can* exercise without a
// real Postgres instance: updateMany's WHERE clause acts as a compare-and-swap
// against `status`. Two callers racing against the same row never both see
// count===1 — exactly the guarantee the real DB's row-locking gives the
// production code (see the comment in billing.service.ts#confirmRequest).
function buildFakeTx(initialRow: Record<string, any>) {
  const row = { ...initialRow };
  const userUpdateCalls: any[] = [];

  const tx = {
    creditTopupRequest: {
      findUnique: jest.fn().mockImplementation(async () => ({ ...row })),
      updateMany: jest.fn().mockImplementation(async ({ where, data }: any) => {
        if (row.status !== where.status) {
          return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    user: {
      update: jest.fn().mockImplementation(async (args: any) => {
        userUpdateCalls.push(args);
        return {};
      }),
    },
  };

  return { tx, row, userUpdateCalls };
}

function buildService() {
  const prisma = {
    creditTopupRequest: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const service = new BillingService(prisma as any);
  return { service, prisma };
}

describe('BillingService', () => {
  describe('createTopupRequest', () => {
    it('rejects an amount below the minimum', async () => {
      const { service } = buildService();
      await expect(service.createTopupRequest('u1', 5000)).rejects.toThrow(
        /Amount must be an integer/,
      );
    });

    it('rejects an amount above the maximum', async () => {
      const { service } = buildService();
      await expect(
        service.createTopupRequest('u1', 999_999_999),
      ).rejects.toThrow(/Amount must be an integer/);
    });

    it('rejects a non-integer amount', async () => {
      const { service } = buildService();
      await expect(service.createTopupRequest('u1', 50000.5)).rejects.toThrow(
        /Amount must be an integer/,
      );
    });

    it('creates a PENDING request and computes credits from amount (not stored, not duplicated)', async () => {
      process.env.BANK_BIN = '970436';
      process.env.BANK_ACCOUNT_NO = '0123456789';
      const { service, prisma } = buildService();
      prisma.creditTopupRequest.create.mockResolvedValue({
        id: 'req1',
        orderCode: 'TDABC123',
        amount: 100000,
        status: 'PENDING',
      });

      const result = await service.createTopupRequest('u1', 100000);

      expect(result.credits).toBe(100); // 100000 / VND_PER_CREDIT(1000)
      expect(result.qrUrl).toContain('TDABC123');
    });
  });

  describe('confirmRequest — idempotency (mandatory)', () => {
    it('confirming the same PENDING request twice credits the user exactly once and the second call is a no-op 409', async () => {
      const { service, prisma } = buildService();
      const { tx, userUpdateCalls } = buildFakeTx({
        id: 'req1',
        userId: 'u1',
        amount: 100000,
        status: 'PENDING',
      });
      prisma.$transaction.mockImplementation((cb: any) => cb(tx));

      const first = await service.confirmRequest('req1', 'admin1');
      expect(first.status).toBe('CONFIRMED');
      expect(first.credits).toBe(100);
      expect(userUpdateCalls).toHaveLength(1);
      expect(userUpdateCalls[0]).toEqual({
        where: { id: 'u1' },
        data: { credits: { increment: 100 } },
      });

      await expect(service.confirmRequest('req1', 'admin2')).rejects.toThrow(
        ConflictException,
      );
      // The headline correctness property: a second confirm must NOT increment again.
      expect(userUpdateCalls).toHaveLength(1);
    });

    it('throws NotFoundException for a request that does not exist', async () => {
      const { service, prisma } = buildService();
      const tx = {
        creditTopupRequest: { findUnique: jest.fn().mockResolvedValue(null) },
        user: { update: jest.fn() },
      };
      prisma.$transaction.mockImplementation((cb: any) => cb(tx));

      await expect(service.confirmRequest('missing', 'admin1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejecting an already-CONFIRMED request is also a no-op 409 (not a silent success)', async () => {
      const { service, prisma } = buildService();
      const { tx } = buildFakeTx({
        id: 'req1',
        userId: 'u1',
        amount: 100000,
        status: 'CONFIRMED',
      });
      prisma.$transaction.mockImplementation((cb: any) => cb(tx));

      await expect(service.rejectRequest('req1', 'admin1')).rejects.toThrow(
        ConflictException,
      );
    });
  });
});
