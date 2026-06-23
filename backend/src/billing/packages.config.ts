// Tỷ giá quy đổi VND -> Credits cho luồng nạp tiền (Phase 5).
// Đặt ở đây (không hardcode trong service) để dễ điều chỉnh sau này.
export const VND_PER_CREDIT = 1000; // 1.000 VND = 1 Credit
export const MIN_TOPUP_AMOUNT_VND = 10_000; // Tối thiểu 10 Credits mỗi lần nạp
// Trần hợp lý cho một lần chuyển khoản cá nhân; cũng tránh tràn cột Int (32-bit) của Postgres.
export const MAX_TOPUP_AMOUNT_VND = 50_000_000;

export function creditsForAmount(amountVnd: number): number {
  return Math.floor(amountVnd / VND_PER_CREDIT);
}
