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

// Mirrors TtsService's private hashText — a literal copy of the pre-prosody
// djb2 algorithm, used to prove the no-prosody path hashes byte-identically
// to what it hashed before the prosody feature existed (not just
// self-consistently across calls).
function djb2(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h) ^ text.charCodeAt(i);
    h = h >>> 0;
  }
  return h.toString(16);
}

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

  describe('prosody-aware cache key (dubbing prosody heuristic)', () => {
    it('the same text with vs without prosody produces two distinct cache lookups', async () => {
      const { service, prisma } = buildService();
      prisma.user.findUnique.mockResolvedValue({ credits: 5 });
      prisma.ttsCache.findUnique.mockResolvedValue(null);
      prisma.ttsCache.create.mockResolvedValue({});
      prisma.ttsCache.update.mockResolvedValue({});

      await service.synthesize('u1', 'Nhanh lên!', VALID_VOICE, false);
      await service.synthesize('u1', 'Nhanh lên!', VALID_VOICE, false, {
        rate: '+12%',
        pitch: '+8%',
        volume: '+8%',
      });

      const lookedUpHashes = prisma.ttsCache.findUnique.mock.calls.map(
        (call: any[]) => call[0].where.textHash_voiceId.textHash,
      );
      expect(lookedUpHashes[0]).not.toEqual(lookedUpHashes[1]);
    });

    it('plain-text synthesis (no prosody arg) hashes identically across calls — unchanged from pre-prosody behavior', async () => {
      const { service, prisma } = buildService();
      prisma.user.findUnique.mockResolvedValue({ credits: 5 });
      prisma.ttsCache.findUnique.mockResolvedValue(null);
      prisma.ttsCache.create.mockResolvedValue({});
      prisma.ttsCache.update.mockResolvedValue({});

      await service.synthesize('u1', 'Hello there.', VALID_VOICE, false);
      await service.synthesize('u1', 'Hello there.', VALID_VOICE, false);

      const lookedUpHashes = prisma.ttsCache.findUnique.mock.calls.map(
        (call: any[]) => call[0].where.textHash_voiceId.textHash,
      );
      expect(lookedUpHashes[0]).toEqual(lookedUpHashes[1]);
    });

    it('the no-prosody hash matches the pre-prosody djb2(text) algorithm exactly — true backwards-compat, not just self-consistency', async () => {
      const { service, prisma } = buildService();
      prisma.user.findUnique.mockResolvedValue({ credits: 5 });
      prisma.ttsCache.findUnique.mockResolvedValue(null);
      prisma.ttsCache.create.mockResolvedValue({});
      prisma.ttsCache.update.mockResolvedValue({});

      const text = 'Regression check text.';
      await service.synthesize('u1', text, VALID_VOICE, false);

      const actualHash = prisma.ttsCache.findUnique.mock.calls[0][0].where
        .textHash_voiceId.textHash as string;
      expect(actualHash).toBe(djb2(text));
    });
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
