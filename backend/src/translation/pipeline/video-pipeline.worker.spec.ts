import { VideoPipelineWorker } from './video-pipeline.worker';
import { TranslationService } from '../translation.service';
import { CreditService } from '../../credit/credit.service';

function buildWorker() {
  const prisma: any = {
    videoJob: {
      // onFailed persists via updateMany (status-guarded), not update.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    user: {
      update: jest.fn(),
    },
  };
  const creditService = {
    refundCredit: jest.fn().mockResolvedValue(undefined),
  };
  const worker = new VideoPipelineWorker(
    prisma as any,
    {} as any, // translationService — unused by onFailed
    {} as any, // storage — unused by onFailed
    creditService as any,
    {} as any, // ttsService — unused by onFailed
  );
  return { worker, prisma, creditService };
}

describe('VideoPipelineWorker.onFailed', () => {
  it('does nothing while retry attempts remain', async () => {
    const { worker, prisma } = buildWorker();
    const job = {
      data: { jobId: 'job1' },
      attemptsMade: 1,
      opts: { attempts: 3 },
    } as any;

    await worker.onFailed(job, new Error('transient'));

    expect(prisma.videoJob.updateMany).not.toHaveBeenCalled();
  });

  it('sets FAILED status and refunds credits immediately if error is UnrecoverableError even if attempts remain', async () => {
    const { worker, prisma, creditService } = buildWorker();
    prisma.videoJob.findUnique.mockResolvedValue({ userId: 'u1' });
    const job = {
      data: { jobId: 'job1' },
      attemptsMade: 1,
      opts: { attempts: 3 },
    } as any;

    const { UnrecoverableError } = require('bullmq');
    const error = new UnrecoverableError('Gemini API daily quota exhausted. Vui lòng kiểm tra plan/billing hoặc thử lại vào ngày mai.');

    await worker.onFailed(job, error);

    expect(prisma.videoJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'job1',
        status: { notIn: ['COMPLETED', 'CANCELLED'] },
      },
      data: expect.objectContaining({ status: 'FAILED' }),
    });
    expect(creditService.refundCredit).toHaveBeenCalledWith('u1', 10);
  });

  it('sets FAILED status with a sanitized errorMessage after the final attempt, and refunds credits exactly once', async () => {
    const { worker, prisma, creditService } = buildWorker();
    prisma.videoJob.findUnique.mockResolvedValue({ userId: 'u1' });
    const job = {
      data: { jobId: 'job1' },
      attemptsMade: 3,
      opts: { attempts: 3 },
    } as any;

    await worker.onFailed(
      job,
      new Error('/tmp/whatever/leaked-path ffmpeg exited 1'),
    );

    expect(prisma.videoJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'job1',
        status: { notIn: ['COMPLETED', 'CANCELLED'] },
      },
      data: expect.objectContaining({ status: 'FAILED' }),
    });
    // The raw error (which can contain filesystem paths) must never leak into errorMessage.
    const persisted = prisma.videoJob.updateMany.mock.calls[0][0].data.errorMessage;
    expect(persisted).not.toContain('/tmp');
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(creditService.refundCredit).toHaveBeenCalledTimes(1);
    expect(creditService.refundCredit).toHaveBeenCalledWith('u1', 10);
  });

  it('does not refund when the FAILED transition matches 0 rows (job already terminal via a concurrent path)', async () => {
    const { worker, prisma, creditService } = buildWorker();
    prisma.videoJob.updateMany.mockResolvedValue({ count: 0 });
    const job = {
      data: { jobId: 'job1' },
      attemptsMade: 3,
      opts: { attempts: 3 },
    } as any;

    await worker.onFailed(job, new Error('boom'));

    expect(creditService.refundCredit).not.toHaveBeenCalled();
  });

  it('does nothing if the job is undefined', async () => {
    const { worker, prisma } = buildWorker();
    await worker.onFailed(undefined, new Error('x'));
    expect(prisma.videoJob.updateMany).not.toHaveBeenCalled();
  });
});

describe('VideoPipelineWorker.runBurnPhase — cancel guard (C1)', () => {
  it('returns early and does nothing when the job is already CANCELLED', async () => {
    const { worker, prisma } = buildWorker();
    prisma.videoJob.findUnique.mockResolvedValue({
      id: 'job1',
      status: 'CANCELLED',
    });

    await (worker as any).runBurnPhase('job1');

    expect(prisma.videoJob.update).not.toHaveBeenCalled();
    expect(prisma.videoJob.updateMany).not.toHaveBeenCalled();
  });

  it('throws JOB_CANCELLED and never resurrects status to PROCESSING when the job is cancelled between load and the pre-update check', async () => {
    const { worker, prisma } = buildWorker();
    prisma.videoJob.findUnique
      .mockResolvedValueOnce({
        id: 'job1',
        status: 'PROCESSING',
        translatedSegments: [{ start: 0, end: 1, text: 'a', translatedText: 'b' }],
        inputStorageKey: 'k',
        userId: 'u1',
        fileName: 'a.mp4',
        outputMode: 'burn',
        removeSourceSubs: false,
      })
      // assertNotCancelled's status-only lookup, called right before the
      // PROCESSING overwrite — simulates a cancel landing in that window.
      .mockResolvedValueOnce({ status: 'CANCELLED' });

    await expect((worker as any).runBurnPhase('job1')).rejects.toThrow(
      'JOB_CANCELLED',
    );
    expect(prisma.videoJob.update).not.toHaveBeenCalled();
  });
});

describe('Cross-path exactly-once refund (R2 gate): cancel vs permanent failure racing the same job', () => {
  function buildSharedFakes() {
    let jobRow: any = { id: 'job1', userId: 'u1', status: 'PROCESSING' };
    let userCredits = 0; // credits were already reserved at job creation

    const prisma: any = {
      videoJob: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.id === jobRow.id ? { ...jobRow } : null,
        ),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const statusOk = where.status.in
            ? where.status.in.includes(jobRow.status)
            : !where.status.notIn.includes(jobRow.status);
          if (where.id !== jobRow.id || !statusOk) return { count: 0 };
          jobRow = { ...jobRow, ...data };
          return { count: 1 };
        }),
      },
      user: {
        update: jest.fn(async ({ data }: any) => {
          if (data.credits?.increment) userCredits += data.credits.increment;
          return { credits: userCredits };
        }),
      },
    };

    const creditService = new CreditService(prisma);
    const translationService = new TranslationService(
      prisma,
      creditService,
      {} as any,
    );
    const worker = new VideoPipelineWorker(
      prisma,
      {} as any,
      {} as any,
      creditService,
      {} as any, // ttsService — unused by these paths
    );

    return {
      translationService,
      worker,
      getCredits: () => userCredits,
      getStatus: () => jobRow.status,
    };
  }

  it('refunds exactly once when cancel wins the race before permanent failure lands', async () => {
    const { translationService, worker, getCredits, getStatus } =
      buildSharedFakes();

    await translationService.cancelVideoJob('u1', 'job1');
    expect(getStatus()).toBe('CANCELLED');
    expect(getCredits()).toBe(10);

    const failedJob = {
      data: { jobId: 'job1' },
      attemptsMade: 3,
      opts: { attempts: 3 },
    } as any;
    await worker.onFailed(failedJob, new Error('boom'));

    expect(getStatus()).toBe('CANCELLED'); // onFailed's updateMany matched 0 rows
    expect(getCredits()).toBe(10); // refunded exactly once total
  });

  it('refunds exactly once when permanent failure wins the race before cancel lands', async () => {
    const { translationService, worker, getCredits, getStatus } =
      buildSharedFakes();

    const failedJob = {
      data: { jobId: 'job1' },
      attemptsMade: 3,
      opts: { attempts: 3 },
    } as any;
    await worker.onFailed(failedJob, new Error('boom'));
    expect(getStatus()).toBe('FAILED');
    expect(getCredits()).toBe(10);

    await expect(
      translationService.cancelVideoJob('u1', 'job1'),
    ).rejects.toThrow();
    expect(getCredits()).toBe(10); // still refunded exactly once total
  });
});

describe('VideoPipelineWorker.process branch routing', () => {
  it('routes job.name "process-video-burn" to the burn phase', async () => {
    const { worker } = buildWorker();
    const burnSpy = jest
      .spyOn(worker as any, 'runBurnPhase')
      .mockResolvedValue(undefined);
    const translateSpy = jest
      .spyOn(worker as any, 'runTranslatePhase')
      .mockResolvedValue(undefined);

    await worker.process({
      name: 'process-video-burn',
      data: { jobId: 'job1' },
    } as any);

    expect(burnSpy).toHaveBeenCalledWith('job1');
    expect(translateSpy).not.toHaveBeenCalled();
  });

  it('routes job.name "process-video" to the translate phase', async () => {
    const { worker } = buildWorker();
    const burnSpy = jest
      .spyOn(worker as any, 'runBurnPhase')
      .mockResolvedValue(undefined);
    const translateSpy = jest
      .spyOn(worker as any, 'runTranslatePhase')
      .mockResolvedValue(undefined);

    await worker.process({
      name: 'process-video',
      data: { jobId: 'job2' },
    } as any);

    expect(translateSpy).toHaveBeenCalledWith('job2');
    expect(burnSpy).not.toHaveBeenCalled();
  });
});
