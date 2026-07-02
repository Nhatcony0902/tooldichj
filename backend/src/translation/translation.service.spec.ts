import { TranslationService } from './translation.service';

function buildService(opts: { ai: any } = { ai: null }) {
  const prisma: any = {
    user: { findUnique: jest.fn(), updateMany: jest.fn() },
    translationCache: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    translationHistory: {
      create: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({}),
    },
    videoJob: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  // createVideoJob runs its reserve+create inside prisma.$transaction; the
  // mock just invokes the callback with the same prisma double as `tx`.
  prisma.$transaction = jest.fn((fn: (tx: any) => unknown) => fn(prisma));
  const creditService = {
    deductCredit: jest.fn().mockResolvedValue(undefined),
    reserveCredit: jest.fn().mockResolvedValue(undefined),
    refundCredit: jest.fn().mockResolvedValue(undefined),
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

      expect(result).toEqual({
        translatedText: 'xin chào',
        detectedLang: null,
      });
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

      expect(result).toEqual({
        translatedText: '[Mock Dịch sang vi]: hello',
        detectedLang: null,
      });
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

      expect(result).toEqual({
        translatedText: '[Mock Dịch sang vi]: hello',
        detectedLang: null,
      });
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

      expect(result).toEqual({ translatedText: 'xin chào', detectedLang: null });
      expect(prisma.translationCache.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ translatedText: 'xin chào' }),
      });
      expect(creditService.deductCredit).toHaveBeenCalledWith('u1', 1);
    });

    it('returns an empty string for blank input without touching credits or cache', async () => {
      const { service, prisma, creditService } = buildService();

      const result = await service.translate('u1', '   ', 'en', 'vi');

      expect(result).toEqual({ translatedText: '', detectedLang: null });
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

      expect(result).toEqual({ translatedText: 'xin chào', detectedLang: null });
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
      expect(result.translatedText).toContain('translated:');
      expect(result.detectedLang).toBeNull();
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

  describe('translate — auto-detect', () => {
    it('resolves a sane detectedLang and the correct translation for a valid combined-prompt response', async () => {
      const ai = {
        models: {
          generateContent: jest.fn().mockResolvedValue({
            text: '{"detectedLang":"vi","translatedText":"hello"}',
          }),
        },
      };
      const { service, prisma, creditService } = buildService({ ai });
      prisma.user.findUnique.mockResolvedValue({ credits: 5 });
      prisma.translationCache.findUnique.mockResolvedValue(null);
      prisma.translationCache.create.mockResolvedValue({});

      const result = await service.translate('u1', 'xin chào', 'auto', 'en');

      expect(result).toEqual({
        translatedText: 'hello',
        detectedLang: 'vi',
      });
      expect(ai.models.generateContent).toHaveBeenCalledTimes(1);
      expect(creditService.deductCredit).toHaveBeenCalledWith('u1', 1);
    });

    it('strips markdown fences before parsing the combined detect+translate JSON response', async () => {
      const ai = {
        models: {
          generateContent: jest.fn().mockResolvedValue({
            text: '```json\n{"detectedLang":"en","translatedText":"xin chào"}\n```',
          }),
        },
      };
      const { service, prisma } = buildService({ ai });
      prisma.user.findUnique.mockResolvedValue({ credits: 5 });
      prisma.translationCache.findUnique.mockResolvedValue(null);
      prisma.translationCache.create.mockResolvedValue({});

      const result = await service.translate('u1', 'hello', 'auto', 'vi');

      expect(result).toEqual({
        translatedText: 'xin chào',
        detectedLang: 'en',
      });
    });

    it('throws a manual-select error when the detected language is not in the allowlist', async () => {
      const ai = {
        models: {
          generateContent: jest.fn().mockResolvedValue({
            text: '{"detectedLang":"xx","translatedText":"???"}',
          }),
        },
      };
      const { service, prisma } = buildService({ ai });
      prisma.user.findUnique.mockResolvedValue({ credits: 5 });
      prisma.translationCache.findUnique.mockResolvedValue(null);

      await expect(
        service.translate('u1', 'OK', 'auto', 'en'),
      ).rejects.toThrow(/please select it manually/);
    });

    it('throws a manual-select error when the Gemini response is not parseable JSON', async () => {
      const ai = {
        models: {
          generateContent: jest
            .fn()
            .mockResolvedValue({ text: 'not json at all' }),
        },
      };
      const { service, prisma } = buildService({ ai });
      prisma.user.findUnique.mockResolvedValue({ credits: 5 });
      prisma.translationCache.findUnique.mockResolvedValue(null);

      await expect(
        service.translate('u1', 'gibberish', 'auto', 'en'),
      ).rejects.toThrow(/please select it manually/);
    });

    it('detects the language ONCE on a multi-chunk auto-detect text and reuses it for subsequent chunks', async () => {
      let callIndex = 0;
      const ai = {
        models: {
          generateContent: jest.fn().mockImplementation(() => {
            callIndex += 1;
            if (callIndex === 1) {
              // First call: the combined detect+translate prompt for chunk 1.
              return Promise.resolve({
                text: '{"detectedLang":"vi","translatedText":"chunk1-en"}',
              });
            }
            // Subsequent calls: the normal (non-auto) translate prompt,
            // now using the resolved "vi" as sourceLang.
            return Promise.resolve({ text: `chunk${callIndex}-en` });
          }),
        },
      };
      const { service, prisma, creditService } = buildService({ ai });
      prisma.user.findUnique.mockResolvedValue({ credits: 100 });
      prisma.translationCache.findUnique.mockResolvedValue(null);
      prisma.translationCache.create.mockResolvedValue({});

      const paragraph = 'Đây là một đoạn văn bản tiếng Việt dài. '.repeat(150); // ~6150 chars
      const longText = [paragraph, paragraph, paragraph].join('\n\n'); // multi-chunk

      const result = await service.translate('u1', longText, 'auto', 'en');

      expect(result.detectedLang).toBe('vi');
      const callCount = ai.models.generateContent.mock.calls.length;
      expect(callCount).toBeGreaterThan(1);

      // Exactly one call used the combined detect+translate prompt shape.
      const combinedPromptCalls = ai.models.generateContent.mock.calls.filter(
        ([{ contents }]: [{ contents: string }]) =>
          contents.includes('Detect the language of the following text'),
      );
      expect(combinedPromptCalls).toHaveLength(1);

      // The remaining calls use the normal translate prompt with the
      // resolved "vi" substituted in place of the literal "auto".
      const normalPromptCalls = ai.models.generateContent.mock.calls.filter(
        ([{ contents }]: [{ contents: string }]) =>
          contents.includes('Translate the following text from'),
      );
      expect(normalPromptCalls.length).toBe(callCount - 1);
      for (const [{ contents }] of normalPromptCalls) {
        expect(contents).toContain('from "vi"');
      }

      expect(creditService.deductCredit).toHaveBeenCalledWith(
        'u1',
        callCount,
      );
    });

    it('never serves a whole-text cache hit when sourceLang is "auto" (always re-detects)', async () => {
      const ai = {
        models: {
          generateContent: jest.fn().mockResolvedValue({
            text: '{"detectedLang":"ja","translatedText":"hi"}',
          }),
        },
      };
      const { service, prisma } = buildService({ ai });
      prisma.user.findUnique.mockResolvedValue({ credits: 5 });
      // Even if a row exists keyed on the literal "auto", it must never be
      // served — a cache hit would carry no real detectedLang.
      prisma.translationCache.findUnique.mockResolvedValue({
        translatedText: 'stale-cached-value',
      });
      prisma.translationCache.create.mockResolvedValue({});

      const result = await service.translate('u1', 'こんにちは', 'auto', 'en');

      expect(result).toEqual({ translatedText: 'hi', detectedLang: 'ja' });
      expect(ai.models.generateContent).toHaveBeenCalledTimes(1);
    });
  });

  describe('translate — history recording', () => {
    it('records a history row with the manually-selected sourceLang when not auto-detecting', async () => {
      const ai = {
        models: {
          generateContent: jest
            .fn()
            .mockResolvedValue({ text: 'xin chào' }),
        },
      };
      const { service, prisma } = buildService({ ai });
      prisma.user.findUnique.mockResolvedValue({ credits: 5 });
      prisma.translationCache.findUnique.mockResolvedValue(null);
      prisma.translationCache.create.mockResolvedValue({});

      await service.translate('u1', 'hello', 'en', 'vi');

      expect(prisma.translationHistory.create).toHaveBeenCalledWith({
        data: {
          userId: 'u1',
          sourceText: 'hello',
          translatedText: 'xin chào',
          sourceLang: 'en',
          targetLang: 'vi',
        },
      });
    });

    it('records the DETECTED language code (never the literal "auto") when auto-detecting', async () => {
      const ai = {
        models: {
          generateContent: jest.fn().mockResolvedValue({
            text: '{"detectedLang":"vi","translatedText":"hello"}',
          }),
        },
      };
      const { service, prisma } = buildService({ ai });
      prisma.user.findUnique.mockResolvedValue({ credits: 5 });
      prisma.translationCache.findUnique.mockResolvedValue(null);
      prisma.translationCache.create.mockResolvedValue({});

      await service.translate('u1', 'xin chào', 'auto', 'en');

      expect(prisma.translationHistory.create).toHaveBeenCalledWith({
        data: {
          userId: 'u1',
          sourceText: 'xin chào',
          translatedText: 'hello',
          sourceLang: 'vi',
          targetLang: 'en',
        },
      });
      const call = prisma.translationHistory.create.mock.calls[0][0];
      expect(call.data.sourceLang).not.toBe('auto');
    });

    it('does not throw or fail translate() when the history write fails', async () => {
      const ai = {
        models: {
          generateContent: jest
            .fn()
            .mockResolvedValue({ text: 'xin chào' }),
        },
      };
      const { service, prisma } = buildService({ ai });
      prisma.user.findUnique.mockResolvedValue({ credits: 5 });
      prisma.translationCache.findUnique.mockResolvedValue(null);
      prisma.translationCache.create.mockResolvedValue({});
      prisma.translationHistory.create.mockRejectedValue(new Error('db down'));

      const result = await service.translate('u1', 'hello', 'en', 'vi');

      expect(result).toEqual({ translatedText: 'xin chào', detectedLang: null });
    });

    it('prunes the oldest rows once a user exceeds 50 history rows', async () => {
      const ai = {
        models: {
          generateContent: jest
            .fn()
            .mockResolvedValue({ text: 'xin chào' }),
        },
      };
      const { service, prisma } = buildService({ ai });
      prisma.user.findUnique.mockResolvedValue({ credits: 5 });
      prisma.translationCache.findUnique.mockResolvedValue(null);
      prisma.translationCache.create.mockResolvedValue({});
      prisma.translationHistory.count.mockResolvedValue(51);
      prisma.translationHistory.findMany.mockResolvedValue([
        { id: 'oldest-1' },
      ]);

      await service.translate('u1', 'hello', 'en', 'vi');

      expect(prisma.translationHistory.findMany).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        orderBy: { createdAt: 'asc' },
        take: 1,
        select: { id: true },
      });
      expect(prisma.translationHistory.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['oldest-1'] } },
      });
    });

    it('does not prune when the row count is at or below 50', async () => {
      const ai = {
        models: {
          generateContent: jest
            .fn()
            .mockResolvedValue({ text: 'xin chào' }),
        },
      };
      const { service, prisma } = buildService({ ai });
      prisma.user.findUnique.mockResolvedValue({ credits: 5 });
      prisma.translationCache.findUnique.mockResolvedValue(null);
      prisma.translationCache.create.mockResolvedValue({});
      prisma.translationHistory.count.mockResolvedValue(50);

      await service.translate('u1', 'hello', 'en', 'vi');

      expect(prisma.translationHistory.findMany).not.toHaveBeenCalled();
      expect(prisma.translationHistory.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('getHistory', () => {
    it('returns the user history, newest first, capped at 50', async () => {
      const { service, prisma } = buildService();
      const rows = [{ id: 'h1' }, { id: 'h2' }];
      prisma.translationHistory.findMany.mockResolvedValue(rows);

      const result = await service.getHistory('u1');

      expect(result).toBe(rows);
      expect(prisma.translationHistory.findMany).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
    });
  });

  describe('clearHistory', () => {
    it('deletes all history rows for the given user', async () => {
      const { service, prisma } = buildService();

      await service.clearHistory('u1');

      expect(prisma.translationHistory.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'u1' },
      });
    });
  });

  describe('createVideoJob', () => {
    it('rejects when the user has fewer than 10 credits (atomic reserve matches 0 rows)', async () => {
      const { service, prisma } = buildService();
      prisma.user.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.createVideoJob('u1', {
          fileName: 'a.mp4',
          inputStorageKey: 'k',
          targetLang: 'vi',
          outputMode: 'burn',
        }),
      ).rejects.toThrow(/10 credits/);
      expect(prisma.videoJob.create).not.toHaveBeenCalled();
    });

    it('creates a PENDING job when the user has enough credits, reserving 10 credits atomically', async () => {
      const { service, prisma } = buildService();
      prisma.user.updateMany.mockResolvedValue({ count: 1 });
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
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: 'u1', credits: { gte: 10 } },
        data: { credits: { decrement: 10 } },
      });
      expect(prisma.videoJob.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ status: 'PENDING', progress: 0 }),
      });
    });

    it('2 concurrent createVideoJob calls against a balance of 10: exactly 1 succeeds, the other throws, final balance is 0', async () => {
      const { service, prisma } = buildService();
      let credits = 10;
      prisma.user.updateMany.mockImplementation(
        async ({ where, data }: any) => {
          if (credits >= where.credits.gte) {
            credits -= data.credits.decrement;
            return { count: 1 };
          }
          return { count: 0 };
        },
      );
      prisma.videoJob.create.mockImplementation(async ({ data }: any) => ({
        id: 'job-x',
        ...data,
      }));

      const params = {
        fileName: 'a.mp4',
        inputStorageKey: 'k',
        targetLang: 'vi',
        outputMode: 'burn',
      };
      const results = await Promise.allSettled([
        service.createVideoJob('u1', params),
        service.createVideoJob('u1', params),
      ]);

      const succeeded = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r) => r.status === 'rejected');
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect((failed[0] as PromiseRejectedResult).reason.message).toMatch(
        /10 credits/,
      );
      expect(credits).toBe(0);
    });
  });

  describe('cancelVideoJob', () => {
    it('refunds 10 credits exactly once when it successfully cancels a PROCESSING job', async () => {
      const { service, prisma, creditService } = buildService();
      prisma.videoJob.findUnique
        .mockResolvedValueOnce({ id: 'job1', userId: 'u1', status: 'PROCESSING' })
        .mockResolvedValueOnce({ id: 'job1', userId: 'u1', status: 'CANCELLED' });
      prisma.videoJob.updateMany.mockResolvedValue({ count: 1 });

      await service.cancelVideoJob('u1', 'job1');

      expect(creditService.refundCredit).toHaveBeenCalledTimes(1);
      expect(creditService.refundCredit).toHaveBeenCalledWith('u1', 10);
    });

    it('does not refund when the job has already changed state (updateMany matches 0 rows)', async () => {
      const { service, prisma, creditService } = buildService();
      prisma.videoJob.findUnique.mockResolvedValue({
        id: 'job1',
        userId: 'u1',
        status: 'PROCESSING',
      });
      prisma.videoJob.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.cancelVideoJob('u1', 'job1')).rejects.toThrow();
      expect(creditService.refundCredit).not.toHaveBeenCalled();
    });
  });

  describe('failOrphanedVideoJob', () => {
    it('flips PENDING -> FAILED and refunds 10 credits exactly once', async () => {
      const { service, prisma, creditService } = buildService();
      prisma.videoJob.updateMany.mockResolvedValue({ count: 1 });
      prisma.videoJob.findUnique.mockResolvedValue({ id: 'job1', userId: 'u1', status: 'FAILED' });

      await service.failOrphanedVideoJob('job1');

      expect(prisma.videoJob.updateMany).toHaveBeenCalledWith({
        where: { id: 'job1', status: 'PENDING' },
        data: expect.objectContaining({ status: 'FAILED' }),
      });
      expect(creditService.refundCredit).toHaveBeenCalledTimes(1);
      expect(creditService.refundCredit).toHaveBeenCalledWith('u1', 10);
    });

    it('does not refund when the job already changed state (updateMany matches 0 rows)', async () => {
      const { service, prisma, creditService } = buildService();
      prisma.videoJob.updateMany.mockResolvedValue({ count: 0 });

      await service.failOrphanedVideoJob('job1');

      expect(creditService.refundCredit).not.toHaveBeenCalled();
      expect(prisma.videoJob.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('rollbackToAwaitingReview', () => {
    it('flips PROCESSING -> AWAITING_REVIEW so a retried confirm can succeed', async () => {
      const { service, prisma } = buildService();
      prisma.videoJob.updateMany.mockResolvedValue({ count: 1 });

      await service.rollbackToAwaitingReview('job1');

      expect(prisma.videoJob.updateMany).toHaveBeenCalledWith({
        where: { id: 'job1', status: 'PROCESSING' },
        data: { status: 'AWAITING_REVIEW' },
      });
    });

    it('no-ops (does not throw) when a concurrent duplicate confirm already changed the state', async () => {
      const { service, prisma } = buildService();
      prisma.videoJob.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.rollbackToAwaitingReview('job1')).resolves.toBeUndefined();
    });
  });
});
