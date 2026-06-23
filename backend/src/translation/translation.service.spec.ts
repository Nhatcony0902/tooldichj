import { TranslationService } from './translation.service';

function buildService(opts: { ai: any } = { ai: null }) {
  const prisma = {
    user: { findUnique: jest.fn() },
    translationCache: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    videoJob: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
  };
  const creditService = {
    deductCredit: jest.fn().mockResolvedValue(undefined),
  };
  const geminiClient = {
    getHash: jest.fn((text: string) => `hash:${text}`),
    getAi: jest.fn(() => opts.ai),
  };

  const service = new TranslationService(
    prisma as any,
    creditService as any,
    geminiClient as any,
  );

  return { service, prisma, creditService, geminiClient };
}

describe('TranslationService', () => {
  describe('translate', () => {
    it('throws when the user has no credits left', async () => {
      const { service, prisma } = buildService();
      prisma.user.findUnique.mockResolvedValue({ credits: 0 });

      await expect(
        service.translate('u1', 'hello', 'en', 'vi'),
      ).rejects.toThrow(/hết Credits/);
    });

    it('serves a cache hit without calling Gemini, and still deducts 1 credit', async () => {
      const { service, prisma, creditService, geminiClient } = buildService();
      prisma.user.findUnique.mockResolvedValue({ credits: 5 });
      prisma.translationCache.findUnique.mockResolvedValue({
        translatedText: 'xin chào',
      });

      const result = await service.translate('u1', 'hello', 'en', 'vi');

      expect(result).toBe('xin chào');
      expect(geminiClient.getAi).not.toHaveBeenCalled();
      expect(creditService.deductCredit).toHaveBeenCalledWith('u1', 1);
    });

    it('does not deduct credit when chargeCredit=false on a cache hit', async () => {
      const { service, prisma, creditService } = buildService();
      prisma.user.findUnique.mockResolvedValue({ credits: 5 });
      prisma.translationCache.findUnique.mockResolvedValue({
        translatedText: 'xin chào',
      });

      await service.translate('u1', 'hello', 'en', 'vi', false);

      expect(creditService.deductCredit).not.toHaveBeenCalled();
    });

    it('falls back to the mock translator when no Gemini client is configured', async () => {
      const { service, prisma, creditService } = buildService({ ai: null });
      prisma.user.findUnique.mockResolvedValue({ credits: 5 });
      prisma.translationCache.findUnique.mockResolvedValue(null);
      prisma.translationCache.create.mockResolvedValue({});

      const result = await service.translate('u1', 'hello', 'en', 'vi');

      expect(result).toBe('[Mock Dịch sang vi]: hello');
      expect(prisma.translationCache.create).toHaveBeenCalled();
      expect(creditService.deductCredit).toHaveBeenCalledWith('u1', 1);
    });

    it('falls back to mock translation if the Gemini call throws', async () => {
      const ai = {
        models: {
          generateContent: jest.fn().mockRejectedValue(new Error('boom')),
        },
      };
      const { service, prisma } = buildService({ ai });
      prisma.user.findUnique.mockResolvedValue({ credits: 5 });
      prisma.translationCache.findUnique.mockResolvedValue(null);
      prisma.translationCache.create.mockResolvedValue({});

      const result = await service.translate('u1', 'hello', 'en', 'vi');

      expect(result).toBe('[Mock Dịch sang vi]: hello');
    });

    it('uses the real Gemini response and caches it when available', async () => {
      const ai = {
        models: {
          generateContent: jest
            .fn()
            .mockResolvedValue({ text: '  xin chào  ' }),
        },
      };
      const { service, prisma, creditService } = buildService({ ai });
      prisma.user.findUnique.mockResolvedValue({ credits: 5 });
      prisma.translationCache.findUnique.mockResolvedValue(null);
      prisma.translationCache.create.mockResolvedValue({});

      const result = await service.translate('u1', 'hello', 'en', 'vi');

      expect(result).toBe('xin chào');
      expect(prisma.translationCache.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ translatedText: 'xin chào' }),
      });
      expect(creditService.deductCredit).toHaveBeenCalledWith('u1', 1);
    });

    it('returns an empty string for blank input without touching credits or cache', async () => {
      const { service, prisma, creditService } = buildService();

      const result = await service.translate('u1', '   ', 'en', 'vi');

      expect(result).toBe('');
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(creditService.deductCredit).not.toHaveBeenCalled();
    });
  });

  describe('translate — chunking', () => {
    it('short text (<= 6000 chars) still does exactly 1 chunk, 1 Gemini call, 1 credit', async () => {
      const ai = {
        models: {
          generateContent: jest
            .fn()
            .mockResolvedValue({ text: 'xin chào' }),
        },
      };
      const { service, prisma, creditService } = buildService({ ai });
      prisma.user.findUnique.mockResolvedValue({ credits: 5 });
      prisma.translationCache.findUnique.mockResolvedValue(null);
      prisma.translationCache.create.mockResolvedValue({});

      const shortText = 'Hello world. '.repeat(50); // well under 6000 chars
      const result = await service.translate('u1', shortText, 'en', 'vi');

      expect(result).toBe('xin chào');
      expect(ai.models.generateContent).toHaveBeenCalledTimes(1);
      expect(creditService.deductCredit).toHaveBeenCalledWith('u1', 1);
    });

    it('multi-paragraph text > 6000 chars splits into multiple chunks and deducts chunks.length credits', async () => {
      const ai = {
        models: {
          generateContent: jest
            .fn()
            .mockImplementation(({ contents }: { contents: string }) =>
              Promise.resolve({ text: `translated:${contents.length}` }),
            ),
        },
      };
      const { service, prisma, creditService } = buildService({ ai });
      prisma.user.findUnique.mockResolvedValue({ credits: 100 });
      // Whole-text cache lookup misses; every per-chunk lookup also misses.
      prisma.translationCache.findUnique.mockResolvedValue(null);
      prisma.translationCache.create.mockResolvedValue({});

      // Build several paragraphs (separated by blank lines) that together
      // exceed the 6000-char chunk size, forcing a multi-chunk split.
      const paragraph = 'Lorem ipsum dolor sit amet. '.repeat(150); // ~4350 chars
      const longText = [paragraph, paragraph, paragraph].join('\n\n'); // > 6000 chars total

      const result = await service.translate('u1', longText, 'en', 'vi');

      expect(ai.models.generateContent.mock.calls.length).toBeGreaterThan(1);
      const callCount = ai.models.generateContent.mock.calls.length;
      expect(creditService.deductCredit).toHaveBeenCalledWith(
        'u1',
        callCount,
      );
      expect(result).toContain('translated:');
    });

    it('a single very long paragraph (no blank-line breaks) falls back to sentence-splitting', async () => {
      const ai = {
        models: {
          generateContent: jest
            .fn()
            .mockImplementation(({ contents }: { contents: string }) =>
              Promise.resolve({ text: `translated:${contents.length}` }),
            ),
        },
      };
      const { service, prisma, creditService } = buildService({ ai });
      prisma.user.findUnique.mockResolvedValue({ credits: 100 });
      prisma.translationCache.findUnique.mockResolvedValue(null);
      prisma.translationCache.create.mockResolvedValue({});

      // One giant paragraph (no "\n\n") made of many sentences, > 6000 chars.
      const singleParagraph = 'This is one sentence. '.repeat(400); // ~9200 chars, no blank lines

      await service.translate('u1', singleParagraph, 'en', 'vi');

      const callCount = ai.models.generateContent.mock.calls.length;
      expect(callCount).toBeGreaterThan(1);
      expect(creditService.deductCredit).toHaveBeenCalledWith(
        'u1',
        callCount,
      );
    });
  });

  describe('createVideoJob', () => {
    it('rejects when the user has fewer than 10 credits', async () => {
      const { service, prisma } = buildService();
      prisma.user.findUnique.mockResolvedValue({ credits: 9 });

      await expect(
        service.createVideoJob('u1', {
          fileName: 'a.mp4',
          inputStorageKey: 'k',
          targetLang: 'vi',
          outputMode: 'burn',
        }),
      ).rejects.toThrow(/10 credits/);
    });

    it('creates a PENDING job when the user has enough credits', async () => {
      const { service, prisma } = buildService();
      prisma.user.findUnique.mockResolvedValue({ credits: 10 });
      prisma.videoJob.create.mockResolvedValue({
        id: 'job1',
        status: 'PENDING',
      });

      const job = await service.createVideoJob('u1', {
        fileName: 'a.mp4',
        inputStorageKey: 'k',
        targetLang: 'vi',
        outputMode: 'burn',
      });

      expect(job.status).toBe('PENDING');
      expect(prisma.videoJob.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ status: 'PENDING', progress: 0 }),
      });
    });
  });
});
