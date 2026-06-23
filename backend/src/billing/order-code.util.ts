import { randomInt } from 'crypto';

// Mã đơn ngắn, an toàn để điền vào nội dung chuyển khoản ngân hàng
// (chỉ chữ hoa + số, không khoảng trắng/ký tự đặc biệt mà app ngân hàng có thể cắt bỏ).
export function generateOrderCode(): string {
  const timestampPart = Date.now().toString(36).toUpperCase();
  const randomPart = randomInt(0, 36 ** 4)
    .toString(36)
    .toUpperCase()
    .padStart(4, '0');
  return `TD${timestampPart}${randomPart}`;
}
