import { Injectable, InternalServerErrorException } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private transporter: nodemailer.Transporter | null = null;

  private getTransporter(): nodemailer.Transporter {
    if (this.transporter) {
      return this.transporter;
    }

    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
    if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
      throw new InternalServerErrorException(
        'Email service is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS in .env',
      );
    }

    this.transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
      },
    });

    return this.transporter;
  }

  async sendOtpEmail(to: string, otp: string): Promise<void> {
    const from = process.env.SMTP_FROM || process.env.SMTP_USER;

    await this.getTransporter().sendMail({
      from,
      to,
      subject: 'Mã xác thực email - ToolDichJ',
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
          <h2>Xác thực địa chỉ email của bạn</h2>
          <p>Mã xác thực của bạn là:</p>
          <p style="font-size: 32px; font-weight: 700; letter-spacing: 4px;">${otp}</p>
          <p>Mã này có hiệu lực trong 10 phút. Vui lòng không chia sẻ mã này với bất kỳ ai.</p>
        </div>
      `,
    });
  }
}
