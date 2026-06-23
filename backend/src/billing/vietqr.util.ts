import { InternalServerErrorException } from '@nestjs/common';

export interface BuildVietQrUrlParams {
  amount: number;
  orderCode: string;
}

// VietQR.io static bank-transfer QR image — no SDK, no merchant account.
// Bank info comes from env (the user's own personal account), never hardcoded.
export function buildVietQrUrl({
  amount,
  orderCode,
}: BuildVietQrUrlParams): string {
  const bankBin = process.env.BANK_BIN;
  const accountNo = process.env.BANK_ACCOUNT_NO;
  const accountName = process.env.BANK_ACCOUNT_NAME;
  const template = process.env.VIETQR_TEMPLATE || 'compact2';

  if (!bankBin || !accountNo) {
    throw new InternalServerErrorException(
      'VietQR is not configured. Set BANK_BIN and BANK_ACCOUNT_NO in .env',
    );
  }

  const params = new URLSearchParams({
    amount: String(amount),
    addInfo: orderCode,
  });
  if (accountName) {
    params.set('accountName', accountName);
  }

  return `https://img.vietqr.io/image/${bankBin}-${accountNo}-${template}.png?${params.toString()}`;
}
