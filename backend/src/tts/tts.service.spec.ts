import { TtsService } from './tts.service';

jest.mock('msedge-tts', () => ({
  MsEdgeTTS: jest.fn().mockImplementation(() => ({
    setMetadata: jest.fn().mockResolvedValue(undefined),
    toStream: jest.fn().mockReturnValue({
      audioStream: {
        on: jest.fn().mockImplementation(function (
          this: any,
          event: string,
          cb: (...args: any[]) => void,
        ) {
          if (event === 'data') cb(Buffer.from('fake-mp3-bytes'));
          if (event === 'end') cb();
          return this;
        }),
      },
    }),
  })),
  OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'mp3' },
}));

const VALID_VOICE = 'vi-VN-HoaiMyNeural';

function buildService() {
  const prisma = {
    user: { findUnique: jest.fn() },
    ttsCache: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };
  const creditService = {
    deductCredit: jest.fn().mockResolvedValue(undefined),
  };
  const storage = {
    save: jest.fn().mockResolvedValue(undefined),
    read: jest.fn().mockResolvedValue(Buffer.from('cached-audio')),
  };

  const service = new TtsService(
    prisma as any,
    creditService as any,
    storage as any,
  );

  return { service, prisma, creditService, storage };
}

describe('TtsService', () => {
  describe('synthesize', () => {
    it('rejects an unknown voiceId', async () => {
      const { service } = buildService();
      await expect(service.synthesize('u1', 'hi', 'NotAVoice')).rejects.toThrow(
        /Unknown voiceId/,
      );
    });

    it('rejects when the user has no credits left', async () => {
      const { service, prisma } = buildService();
      prisma.user.findUnique.mockResolvedValue({ credits: 0 });

      await expect(service.synthesize('u1', 'hi', VALID_VOICE)).rejects.toThrow(
        /hết Credits/,
      );
    });

    it('serves a cached entry without calling Edge TTS, but still deducts 1 credit', async () => {
      const { service, prisma, creditService, storage } = buildService();
      prisma.user.findUnique.mockResolvedValue({ credits: 5 });
      prisma.ttsCache.findUnique.mockResolvedValue({
        audioStorageKey: 'tts/abc.mp3',
      });

      const result = await service.synthesize('u1', 'hi', VALID_VOICE);

      expect(result.cached).toBe(true);
      expect(storage.read).toHaveBeenCalledWith('tts/abc.mp3');
      expect(creditService.deductCredit).toHaveBeenCalledWith('u1', 1);
    });

    it('does not deduct credit when chargeCredit=false', async () => {
      const { service, prisma, creditService } = buildService();
      prisma.user.findUnique.mockResolvedValue({ credits: 5 });
      prisma.ttsCache.findUnique.mockResolvedValue({
        audioStorageKey: 'tts/abc.mp3',
      });

      await service.synthesize('u1', 'hi', VALID_VOICE, false);

      expect(creditService.deductCredit).not.toHaveBeenCalled();
    });

    it('claims the cache slot, synthesizes via Edge TTS, and persists the audio', async () => {
      const { service, prisma, creditService, storage } = buildService();
      prisma.user.findUnique.mockResolvedValue({ credits: 5 });
      prisma.ttsCache.findUnique.mockResolvedValue(null);
      prisma.ttsCache.create.mockResolvedValue({});
      prisma.ttsCache.update.mockResolvedValue({});

      const result = await service.synthesize('u1', 'hi', VALID_VOICE);

      expect(result.cached).toBe(false);
      expect(result.audioBuffer.length).toBeGreaterThan(0);
      expect(storage.save).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.stringContaining('tts/edge-'),
      );
      expect(prisma.ttsCache.update).toHaveBeenCalled();
      expect(creditService.deductCredit).toHaveBeenCalledWith('u1', 1);
    });

    it('waits for and serves a concurrently-claimed entry once the winner finishes', async () => {
      const { service, prisma } = buildService();
      prisma.user.findUnique.mockResolvedValue({ credits: 5 });
      prisma.ttsCache.findUnique
        .mockResolvedValueOnce(null) // initial cache check: miss
        .mockResolvedValueOnce({ audioStorageKey: '' }) // first poll: pending
        .mockResolvedValueOnce({ audioStorageKey: 'tts/done.mp3' }); // second poll: ready
      prisma.ttsCache.create.mockRejectedValue(new Error('unique constraint'));

      const result = await service.synthesize('u1', 'hi', VALID_VOICE);

      expect(result.cached).toBe(true);
    }, 15000);
  });

  describe('getSample', () => {
    it('rejects an unknown voiceId', async () => {
      const { service } = buildService();
      await expect(service.getSample('NotAVoice')).rejects.toThrow(
        /Unknown voiceId/,
      );
    });

    it('does not touch the user/credit path at all (free preview)', async () => {
      const { service, prisma, creditService } = buildService();
      prisma.ttsCache.findUnique.mockResolvedValue({
        audioStorageKey: 'tts/sample.mp3',
      });

      await service.getSample(VALID_VOICE);

      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(creditService.deductCredit).not.toHaveBeenCalled();
    });
  });
});
