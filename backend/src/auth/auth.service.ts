import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as speakeasy from 'speakeasy';
import * as qrcode from 'qrcode';
import {
  RegisterDto,
  LoginDto,
  VerifyEmailDto,
  ResendOtpDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  UpdateProfileDto,
  ChangePasswordDto,
} from './dto/auth.dto';
import { MailService } from '../mail/mail.service';
import { randomInt } from 'crypto';

const OTP_TTL_MS = 10 * 60 * 1000; // 10 phút
const OTP_RESEND_COOLDOWN_MS = 60 * 1000; // 60 giây
const OTP_MAX_ATTEMPTS = 5;
const INVALID_OTP_MESSAGE = 'Invalid or expired verification code';

function generateOtp(): string {
  return String(randomInt(100000, 1000000));
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private mailService: MailService,
  ) {}

  async register(dto: RegisterDto) {
    const { email, password, name, phone } = dto;
    if (!email || !password || !name) {
      throw new BadRequestException('Email, password, and name are required');
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });
    if (existingUser) {
      throw new BadRequestException('Email already registered');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const otp = generateOtp();
    const user = await this.prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        phone,
        credits: 100, // Tặng 100 credits cho tài khoản mới
        emailVerifyOtp: otp,
        emailVerifyOtpExpiresAt: new Date(Date.now() + OTP_TTL_MS),
        emailVerifyLastSentAt: new Date(),
      },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        role: true,
        credits: true,
        createdAt: true,
      },
    });

    let emailSent = true;
    try {
      await this.mailService.sendOtpEmail(email, otp);
    } catch (err) {
      emailSent = false;
      console.error('Failed to send verification email:', err);
    }

    return {
      success: true,
      message: emailSent
        ? 'Registration successful. Please check your email for the verification code.'
        : 'Registration successful, but the verification email could not be sent. Please use the resend option.',
      emailSent,
      user,
    };
  }

  async verifyEmail(dto: VerifyEmailDto) {
    const { email, otp } = dto;
    if (!email || !otp) {
      throw new BadRequestException('Email and verification code are required');
    }

    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new BadRequestException(INVALID_OTP_MESSAGE);
    }

    if (user.emailVerified) {
      return {
        success: true,
        message: 'Email is already verified',
      };
    }

    if (user.emailVerifyAttempts >= OTP_MAX_ATTEMPTS) {
      throw new BadRequestException(
        'Too many failed attempts. Please request a new verification code.',
      );
    }

    if (
      !user.emailVerifyOtp ||
      !user.emailVerifyOtpExpiresAt ||
      user.emailVerifyOtpExpiresAt < new Date() ||
      user.emailVerifyOtp !== otp
    ) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { emailVerifyAttempts: { increment: 1 } },
      });
      throw new BadRequestException(INVALID_OTP_MESSAGE);
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        emailVerifyOtp: null,
        emailVerifyOtpExpiresAt: null,
        emailVerifyLastSentAt: null,
        emailVerifyAttempts: 0,
      },
    });

    return {
      success: true,
      message: 'Email verified successfully',
    };
  }

  async resendOtp(dto: ResendOtpDto) {
    const { email } = dto;
    if (!email) {
      throw new BadRequestException('Email is required');
    }

    const genericResponse = {
      success: true,
      message:
        'If this email is registered and not yet verified, a new verification code has been sent.',
    };

    const user = await this.prisma.user.findUnique({ where: { email } });
    // Không tiết lộ email có tồn tại hay không / đã verify hay chưa (chống enumeration).
    if (!user || user.emailVerified) {
      return genericResponse;
    }

    if (
      user.emailVerifyLastSentAt &&
      Date.now() - user.emailVerifyLastSentAt.getTime() < OTP_RESEND_COOLDOWN_MS
    ) {
      throw new BadRequestException(
        'Please wait before requesting another verification code',
      );
    }

    const otp = generateOtp();
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerifyOtp: otp,
        emailVerifyOtpExpiresAt: new Date(Date.now() + OTP_TTL_MS),
        emailVerifyLastSentAt: new Date(),
        emailVerifyAttempts: 0,
      },
    });

    try {
      await this.mailService.sendOtpEmail(email, otp);
    } catch (err) {
      console.error('Failed to send verification email:', err);
    }

    return genericResponse;
  }

  async login(dto: LoginDto) {
    const { email, password } = dto;
    if (!email || !password) {
      throw new BadRequestException('Email and password are required');
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
    });
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (!user.emailVerified) {
      throw new ForbiddenException(
        'Email is not verified. Please verify your email before logging in.',
      );
    }

    // Kiểm tra xem MFA có được bật không
    if (user.mfaEnabled) {
      const tempToken = this.jwtService.sign(
        { sub: user.id, isPendingMfa: true },
        { expiresIn: '5m' },
      );
      return {
        success: true,
        mfaRequired: true,
        tempToken,
      };
    }

    const payload = { sub: user.id, email: user.email };
    const token = this.jwtService.sign(payload);

    return {
      success: true,
      accessToken: token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        credits: user.credits,
        preferredVoiceId: user.preferredVoiceId,
      },
    };
  }

  async loginMfa(tempToken: string, code: string) {
    if (!tempToken || !code) {
      throw new BadRequestException(
        'Temp token and verification code are required',
      );
    }

    try {
      const payload = this.jwtService.verify<{
        sub: string;
        isPendingMfa?: boolean;
      }>(tempToken);
      if (payload.isPendingMfa !== true) {
        throw new UnauthorizedException('Invalid temporary token');
      }

      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
      });
      if (!user || !user.mfaEnabled || !user.mfaSecret) {
        throw new UnauthorizedException('MFA not configured for this user');
      }

      const isVerified = speakeasy.totp.verify({
        secret: user.mfaSecret,
        encoding: 'base32',
        token: code,
        window: 1, // cho phép lệch 30s trước/sau
      });

      if (!isVerified) {
        throw new UnauthorizedException('MFA verification code is invalid');
      }

      const accessToken = this.jwtService.sign({
        sub: user.id,
        email: user.email,
      });

      return {
        success: true,
        accessToken,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          credits: user.credits,
          preferredVoiceId: user.preferredVoiceId,
        },
      };
    } catch (err: any) {
      if (
        err instanceof UnauthorizedException ||
        err instanceof BadRequestException
      ) {
        throw err;
      }
      throw new UnauthorizedException(
        'Temporary token has expired or is invalid',
      );
    }
  }

  async setupMfa(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new BadRequestException('User not found');
    }

    const secretObj = speakeasy.generateSecret({
      length: 10,
      name: `ToolDichJ:${user.email}`,
      issuer: 'ToolDichJ',
    });

    const secret = secretObj.base32;
    const otpauthUrl = secretObj.otpauth_url;

    if (!otpauthUrl) {
      throw new BadRequestException('Could not generate otpauth URL');
    }

    const qrCode = await qrcode.toDataURL(otpauthUrl);

    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaPendingSecret: secret },
    });

    return {
      secret,
      qrCode,
    };
  }

  async verifyAndEnableMfa(userId: string, code: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!user || !user.mfaPendingSecret) {
      throw new BadRequestException('MFA setup was not initiated');
    }

    const isVerified = speakeasy.totp.verify({
      secret: user.mfaPendingSecret,
      encoding: 'base32',
      token: code,
      window: 1,
    });

    if (!isVerified) {
      throw new BadRequestException('Verification code is invalid');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        mfaEnabled: true,
        mfaSecret: user.mfaPendingSecret,
        mfaPendingSecret: null,
      },
    });

    return {
      success: true,
      message: 'Multi-factor authentication enabled successfully',
    };
  }

  async disableMfa(userId: string, code: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!user || !user.mfaEnabled || !user.mfaSecret) {
      throw new BadRequestException('MFA is not enabled for this user');
    }

    const isVerified = speakeasy.totp.verify({
      secret: user.mfaSecret,
      encoding: 'base32',
      token: code,
      window: 1,
    });

    if (!isVerified) {
      throw new BadRequestException('Verification code is invalid');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        mfaEnabled: false,
        mfaSecret: null,
        mfaPendingSecret: null,
      },
    });

    return {
      success: true,
      message: 'Multi-factor authentication disabled successfully',
    };
  }

  async requestPasswordReset(dto: ForgotPasswordDto) {
    const { email } = dto;
    if (!email) {
      throw new BadRequestException('Email is required');
    }

    const genericResponse = {
      success: true,
      message:
        'If this email is registered, a password reset code has been sent.',
    };

    // Anti-enumeration: same response whether or not the email exists.
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      return genericResponse;
    }

    // Same cooldown guard as resendOtp — without it this endpoint can spam a
    // victim's inbox and continuously rotate their reset OTP out from under them.
    if (
      user.passwordResetLastSentAt &&
      Date.now() - user.passwordResetLastSentAt.getTime() <
        OTP_RESEND_COOLDOWN_MS
    ) {
      throw new BadRequestException(
        'Please wait before requesting another password reset code',
      );
    }

    const otp = generateOtp();
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetOtp: otp,
        passwordResetOtpExpiresAt: new Date(Date.now() + OTP_TTL_MS),
        passwordResetLastSentAt: new Date(),
        passwordResetAttempts: 0,
      },
    });

    try {
      await this.mailService.sendPasswordResetEmail(email, otp);
    } catch (err) {
      console.error('Failed to send password reset email:', err);
    }

    return genericResponse;
  }

  async resetPassword(dto: ResetPasswordDto) {
    const { email, otp, newPassword } = dto;
    if (!email || !otp || !newPassword) {
      throw new BadRequestException(
        'Email, verification code, and new password are required',
      );
    }

    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordResetOtp || !user.passwordResetOtpExpiresAt) {
      throw new BadRequestException(INVALID_OTP_MESSAGE);
    }

    // Same max-attempts guard as verifyEmail — without it a known email's
    // 6-digit OTP is brute-forceable (per-IP throttling alone doesn't cap it).
    if (user.passwordResetAttempts >= OTP_MAX_ATTEMPTS) {
      throw new BadRequestException(
        'Too many failed attempts. Please request a new password reset code.',
      );
    }

    if (
      user.passwordResetOtpExpiresAt < new Date() ||
      user.passwordResetOtp !== otp
    ) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { passwordResetAttempts: { increment: 1 } },
      });
      throw new BadRequestException(INVALID_OTP_MESSAGE);
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        passwordResetOtp: null,
        passwordResetOtpExpiresAt: null,
        passwordResetLastSentAt: null,
        passwordResetAttempts: 0,
      },
    });

    return {
      success: true,
      message:
        'Password reset successfully. Please log in with your new password.',
    };
  }

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        avatarUrl: true,
        role: true,
        credits: true,
        mfaEnabled: true,
        preferredVoiceId: true,
      },
    });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    return user;
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const data: Record<string, string> = {};
    if (dto.name !== undefined) {
      const trimmedName = dto.name.trim();
      if (!trimmedName) {
        throw new BadRequestException('Name cannot be empty');
      }
      data.name = trimmedName;
    }
    if (dto.phone !== undefined) data.phone = dto.phone.trim();
    if (dto.avatarUrl !== undefined) data.avatarUrl = dto.avatarUrl.trim();

    const user = await this.prisma.user.update({
      where: { id: userId },
      data,
    });
    return {
      id: user.id,
      name: user.name,
      phone: user.phone,
      avatarUrl: user.avatarUrl,
    };
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const { currentPassword, newPassword } = dto;
    if (!currentPassword || !newPassword) {
      throw new BadRequestException(
        'Current password and new password are required',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      throw new BadRequestException('Current password is incorrect');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    return {
      success: true,
      message: 'Password changed successfully',
    };
  }
}
