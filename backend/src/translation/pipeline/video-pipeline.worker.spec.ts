import { VideoPipelineWorker } from './video-pipeline.worker';

function buildWorker() {
  const prisma = {
    videoJob: {
      update: jest.fn().mockResolvedValue({}),
    },
    user: {
      update: jest.fn(),
    },
  };
  const worker = new VideoPipelineWorker(
    prisma as any,
    {} as any, // translationService — unused by onFailed
    {} as any, // ttsService — unused by onFailed
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

    expect(prisma.videoJob.update).not.toHaveBeenCalled();
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

    expect(prisma.videoJob.update).toHaveBeenCalledWith({
      where: { id: 'job1' },
      data: expect.objectContaining({ status: 'FAILED' }),
    });
    // The raw error (which can contain filesystem paths) must never leak into errorMessage.
    const persisted = prisma.videoJob.update.mock.calls[0][0].data.errorMessage;
    expect(persisted).not.toContain('/tmp');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('does nothing if the job is undefined', async () => {
    const { worker, prisma } = buildWorker();
    await worker.onFailed(undefined, new Error('x'));
    expect(prisma.videoJob.update).not.toHaveBeenCalled();
  });
});
