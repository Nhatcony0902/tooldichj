import { VideoPipelineWorker } from './video-pipeline.worker';

function buildWorker() {
  const prisma = {
    videoJob: {
      // onFailed persists via updateMany (status-guarded), not update.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: {
      update: jest.fn(),
    },
  };
  const worker = new VideoPipelineWorker(
    prisma as any,
    {} as any, // translationService — unused by onFailed
    {} as any, // storage — unused by onFailed
  );
  return { worker, prisma };
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

  it('sets FAILED status with a sanitized errorMessage after the final attempt, and never touches credits', async () => {
    const { worker, prisma } = buildWorker();
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
  });

  it('does nothing if the job is undefined', async () => {
    const { worker, prisma } = buildWorker();
    await worker.onFailed(undefined, new Error('x'));
    expect(prisma.videoJob.updateMany).not.toHaveBeenCalled();
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
