export class RegisterDto {
  email: string;
  password?: string;
  name: string;
  phone?: string;
}

export class LoginDto {
  email: string;
  password?: string;
}

export class VerifyEmailDto {
  email: string;
  otp: string;
}

export class ResendOtpDto {
  email: string;
}
