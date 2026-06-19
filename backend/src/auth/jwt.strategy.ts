import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'supersecretkey123',
    });
  }

  async validate(payload: { sub: string; isPendingMfa?: boolean }) {
    if (payload.isPendingMfa) {
      throw new UnauthorizedException('MFA verification required');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, credits: true },
    });
    if (!user) {
      throw new UnauthorizedException('Token is invalid or user not found');
    }
    return user;
  }
}
