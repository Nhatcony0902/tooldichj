import { HttpException, HttpStatus, InternalServerErrorException } from '@nestjs/common';
import { TranslationController } from './translation.controller';
import { InsufficientCreditsError } from '../credit/insufficient-credits.error';

function buildController() {
  const translationService: any = {
    translate: jest.fn(),
    createVideoJob: jest.fn(),
    failOrphanedVideoJob: jest.fn().mockResolvedValue(undefined),
    rollbackToAwaitingReview: jest.fn().mockResolvedValue(undefined),
    confirmVideoJob: jest.fn(),
    getVideoJobs: jest.fn(),
  };
  const queueService: any = {
    enqueueVideoJob: jest.fn().mockResolvedValue(undefined),
    enqueueVideoBurnJob: jest.fn().mockResolvedValue(undefined),
  };
  const storage: any = {
    save: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  };

  const controller = new TranslationController(
    translationService,
    queueService,
    storage,
  );

  return { controller, translationService, queueService, storage };
}

const req = { user: { id: 'u1', email: 'u1@test.com', credits: 5 } };

const file = {
  originalname: 'movie.mp4',
  buffer: Buffer.from('fake'),
} as Express.Multer.File;

describe('TranslationController', () => {
  describe('createVideoJob', () => {
    it('returns HTTP 402 and cleans up the uploaded storage key when credits are insufficient', async () => {
      const { controller, translationService, storage } = buildController();
      translationService.createVideoJob.mockRejectedValue(
        new InsufficientCreditsError('Tài khoản cần có ít nhất 10 credits để thực hiện dịch video!'),
      );

      await expect(
        controller.createVideoJob(file, { targetLang: 'vi' } as any, req as any),
      ).rejects.toMatchObject({
        status: HttpStatus.PAYMENT_REQUIRED,
      });

      expect(storage.delete).toHaveBeenCalledWith(
        expect.stringMatching(/^uploads\/\d+-movie\.mp4$/),
      );
      expect(translationService.createVideoJob).toHaveBeenCalled();
    });

    it('marks the job FAILED, refunds credits, and cleans up storage when enqueue fails', async () => {
      const { controller, translationService, queueService, storage } = buildController();
      translationService.createVideoJob.mockResolvedValue({ id: 'job1', status: 'PENDING' });
      queueService.enqueueVideoJob.mockRejectedValue(new Error('Redis down'));

      await expect(
        controller.createVideoJob(file, { targetLang: 'vi' } as any, req as any),
      ).rejects.toBeInstanceOf(HttpException);

      expect(translationService.failOrphanedVideoJob).toHaveBeenCalledWith('job1');
      expect(storage.delete).toHaveBeenCalledWith(
        expect.stringMatching(/^uploads\/\d+-movie\.mp4$/),
      );
    });

    it('creates the job and returns it when enqueue succeeds', async () => {
      const { controller, translationService, queueService } = buildController();
      const job = { id: 'job1', status: 'PENDING' };
      translationService.createVideoJob.mockResolvedValue(job);

      const result = await controller.createVideoJob(file, { targetLang: 'vi' } as any, req as any);

      expect(result).toEqual({ success: true, job });
      expect(queueService.enqueueVideoJob).toHaveBeenCalledWith('job1');
      expect(translationService.failOrphanedVideoJob).not.toHaveBeenCalled();
    });
  });

  describe('confirmJob', () => {
    it('rolls back to AWAITING_REVIEW and throws a 500 when enqueueing the burn phase fails', async () => {
      const { controller, translationService, queueService } = buildController();
      translationService.confirmVideoJob.mockResolvedValue({ id: 'job1', status: 'PROCESSING' });
      queueService.enqueueVideoBurnJob.mockRejectedValue(new Error('Redis down'));

      await expect(
        controller.confirmJob('job1', req as any),
      ).rejects.toBeInstanceOf(InternalServerErrorException);

      expect(translationService.rollbackToAwaitingReview).toHaveBeenCalledWith('job1');
    });

    it('returns the job normally when enqueueing the burn phase succeeds', async () => {
      const { controller, translationService, queueService } = buildController();
      const job = { id: 'job1', status: 'PROCESSING' };
      translationService.confirmVideoJob.mockResolvedValue(job);

      const result = await controller.confirmJob('job1', req as any);

      expect(result).toEqual({ success: true, job });
      expect(queueService.enqueueVideoBurnJob).toHaveBeenCalledWith('job1');
      expect(translationService.rollbackToAwaitingReview).not.toHaveBeenCalled();
    });
  });

  describe('getVideoJobs', () => {
    it('throws HTTP 500 instead of returning a 200 body on a DB failure', async () => {
      const { controller, translationService } = buildController();
      translationService.getVideoJobs.mockRejectedValue(new Error('DB down'));

      await expect(controller.getVideoJobs(req as any)).rejects.toMatchObject({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
      });
    });

    it('returns the jobs list on success', async () => {
      const { controller, translationService } = buildController();
      const jobs = [{ id: 'job1' }];
      translationService.getVideoJobs.mockResolvedValue(jobs);

      const result = await controller.getVideoJobs(req as any);

      expect(result).toEqual({ success: true, jobs });
    });
  });

  describe('translate', () => {
    it('maps InsufficientCreditsError to HTTP 402', async () => {
      const { controller, translationService } = buildController();
      translationService.translate.mockRejectedValue(
        new InsufficientCreditsError('Tài khoản đã hết Credits.'),
      );

      await expect(
        controller.translate(
          { text: 'hello', sourceLang: 'en', targetLang: 'vi' } as any,
          req as any,
        ),
      ).rejects.toMatchObject({ status: HttpStatus.PAYMENT_REQUIRED });
    });

    it('maps a generic error to HTTP 500', async () => {
      const { controller, translationService } = buildController();
      translationService.translate.mockRejectedValue(new Error('boom'));

      await expect(
        controller.translate(
          { text: 'hello', sourceLang: 'en', targetLang: 'vi' } as any,
          req as any,
        ),
      ).rejects.toMatchObject({ status: HttpStatus.INTERNAL_SERVER_ERROR });
    });
  });
});
