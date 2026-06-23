import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';

function buildService() {
  const prisma = {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };
  const jwtService = {
    sign: jest.fn().mockReturnValue('signed.jwt.token'),
    verify: jest.fn(),
  };
  const mailService = {
    sendOtpEmail: jest.fn().mockResolvedValue(undefined),
    sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
  };

  const service = new AuthService(
    prisma as any,
    jwtService as any,
    mailService as any,
  );

  return { service, prisma, jwtService, mailService };
}

describe('AuthService', () => {
  describe('register', () => {
    it('creates a user with a hashed password and sends the OTP email', async () => {
      const { service, prisma, mailService } = buildService();
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({
        id: 'u1',
        email: 'a@b.com',
        name: 'A',
        phone: null,
        role: 'USER',
        credits: 100,
        createdAt: new Date(),
      });

      const result = await service.register({
        email: 'a@b.com',
        password: 'password123',
        name: 'A',
      });

      expect(result.success).toBe(true);
      expect(result.emailSent).toBe(true);
      expect(mailService.sendOtpEmail).toHaveBeenCalledWith(
        'a@b.com',
        expect.any(String),
      );
      const createArgs = prisma.user.create.mock.calls[0][0];
      expect(createArgs.data.password).not.toBe('password123');
      expect(
        await bcrypt.compare('password123', createArgs.data.password),
      ).toBe(true);
    });

    it('rejects a duplicate email', async () => {
      const { service, prisma } = buildService();
      prisma.user.findUnique.mockResolvedValue({ id: 'existing' });

      await expect(
        service.register({ email: 'a@b.com', password: 'x', name: 'A' } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('verifyEmail', () => {
    it('verifies with a valid, non-expired OTP', async () => {
      const { service, prisma } = buildService();
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        emailVerified: false,
        emailVerifyAttempts: 0,
        emailVerifyOtp: '123456',
        emailVerifyOtpExpiresAt: new Date(Date.now() + 60_000),
      });
      prisma.user.update.mockResolvedValue({});

      const result = await service.verifyEmail({
        email: 'a@b.com',
        otp: '123456',
      });

      expect(result.success).toBe(true);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: expect.objectContaining({ emailVerified: true }),
      });
    });

    it('rejects an expired OTP and increments the attempt counter', async () => {
      const { service, prisma } = buildService();
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        emailVerified: false,
        emailVerifyAttempts: 0,
        emailVerifyOtp: '123456',
        emailVerifyOtpExpiresAt: new Date(Date.now() - 1000),
      });
      prisma.user.update.mockResolvedValue({});

      await expect(
        service.verifyEmail({ email: 'a@b.com', otp: '123456' } as any),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { emailVerifyAttempts: { increment: 1 } },
      });
    });

    it('rejects once max attempts have been reached', async () => {
      const { service, prisma } = buildService();
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        emailVerified: false,
        emailVerifyAttempts: 5,
      });

      await expect(
        service.verifyEmail({ email: 'a@b.com', otp: '000000' } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('resendOtp (anti-enumeration)', () => {
    it('returns the same generic response whether or not the email exists', async () => {
      const { service, prisma } = buildService();
      prisma.user.findUnique.mockResolvedValue(null);
      const forUnknown = await service.resendOtp({
        email: 'nobody@b.com',
      });

      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        emailVerified: true,
      });
      const forVerified = await service.resendOtp({
        email: 'verified@b.com',
      });

      expect(forUnknown).toEqual(forVerified);
      expect(forUnknown.success).toBe(true);
    });
  });

  describe('login', () => {
    it('rejects an invalid password', async () => {
      const { service, prisma } = buildService();
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        password: await bcrypt.hash('correct-password', 10),
        emailVerified: true,
        mfaEnabled: false,
      });

      await expect(
        service.login({ email: 'a@b.com', password: 'wrong-password' } as any),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects login for an unverified email', async () => {
      const { service, prisma } = buildService();
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        password: await bcrypt.hash('password123', 10),
        emailVerified: false,
      });

      await expect(
        service.login({ email: 'a@b.com', password: 'password123' } as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it('returns a tempToken (not an accessToken) when MFA is enabled', async () => {
      const { service, prisma, jwtService } = buildService();
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        password: await bcrypt.hash('password123', 10),
        emailVerified: true,
        mfaEnabled: true,
      });

      const result = await service.login({
        email: 'a@b.com',
        password: 'password123',
      });

      expect(result.mfaRequired).toBe(true);
      expect(result.tempToken).toBe('signed.jwt.token');
      expect(result.accessToken).toBeUndefined();
      expect(jwtService.sign).toHaveBeenCalledWith(
        { sub: 'u1', isPendingMfa: true },
        { expiresIn: '5m' },
      );
    });

    it('returns an accessToken when MFA is disabled', async () => {
      const { service, prisma } = buildService();
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'a@b.com',
        name: 'A',
        role: 'USER',
        credits: 100,
        preferredVoiceId: null,
        password: await bcrypt.hash('password123', 10),
        emailVerified: true,
        mfaEnabled: false,
      });

      const result = await service.login({
        email: 'a@b.com',
        password: 'password123',
      });

      expect(result.success).toBe(true);
      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.mfaRequired).toBeUndefined();
    });
  });

  describe('requestPasswordReset (anti-enumeration)', () => {
    it('returns the generic response without sending an email for an unknown address', async () => {
      const { service, prisma, mailService } = buildService();
      prisma.user.findUnique.mockResolvedValue(null);

      const result = await service.requestPasswordReset({
        email: 'nobody@b.com',
      });

      expect(result.success).toBe(true);
      expect(mailService.sendPasswordResetEmail).not.toHaveBeenCalled();
    });

    it('sets an OTP and sends the reset email for a known address', async () => {
      const { service, prisma, mailService } = buildService();
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com' });
      prisma.user.update.mockResolvedValue({});

      await service.requestPasswordReset({ email: 'a@b.com' });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: expect.objectContaining({ passwordResetOtp: expect.any(String) }),
      });
      expect(mailService.sendPasswordResetEmail).toHaveBeenCalledWith(
        'a@b.com',
        expect.any(String),
      );
    });

    it('rejects a repeat request within the cooldown window (mirrors resendOtp)', async () => {
      const { service, prisma, mailService } = buildService();
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'a@b.com',
        passwordResetLastSentAt: new Date(),
      });

      await expect(
        service.requestPasswordReset({ email: 'a@b.com' }),
      ).rejects.toThrow(BadRequestException);
      expect(mailService.sendPasswordResetEmail).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword', () => {
    it('rejects an invalid or expired OTP', async () => {
      const { service, prisma } = buildService();
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        passwordResetOtp: '123456',
        passwordResetOtpExpiresAt: new Date(Date.now() - 1000),
        passwordResetAttempts: 0,
      });
      prisma.user.update.mockResolvedValue({});

      await expect(
        service.resetPassword({
          email: 'a@b.com',
          otp: '123456',
          newPassword: 'newpass123',
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects once max attempts have been reached (mirrors verifyEmail)', async () => {
      const { service, prisma } = buildService();
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        passwordResetOtp: '123456',
        passwordResetOtpExpiresAt: new Date(Date.now() + 60_000),
        passwordResetAttempts: 5,
      });

      await expect(
        service.resetPassword({
          email: 'a@b.com',
          otp: '123456',
          newPassword: 'newpass123',
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('hashes and persists the new password, then clears the reset OTP', async () => {
      const { service, prisma } = buildService();
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        passwordResetOtp: '123456',
        passwordResetOtpExpiresAt: new Date(Date.now() + 60_000),
        passwordResetAttempts: 0,
      });
      prisma.user.update.mockResolvedValue({});

      const result = await service.resetPassword({
        email: 'a@b.com',
        otp: '123456',
        newPassword: 'newpass123',
      });

      expect(result.success).toBe(true);
      const updateArgs = prisma.user.update.mock.calls[0][0];
      expect(updateArgs.data.passwordResetOtp).toBeNull();
      expect(updateArgs.data.passwordResetOtpExpiresAt).toBeNull();
      expect(await bcrypt.compare('newpass123', updateArgs.data.password)).toBe(
        true,
      );
    });
  });
});
