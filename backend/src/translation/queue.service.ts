import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma.service';

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);
  private isProcessing = false;

  constructor(private prisma: PrismaService) {}

  @Cron('*/3 * * * * *') // Chạy mỗi 3 giây
  async handleQueue() {
    // Tránh chạy đè nếu tác vụ trước đó chưa xử lý xong
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      // Tìm tất cả các job đang ở trạng thái PROCESSING hoặc PENDING
      const activeJobs = await this.prisma.videoJob.findMany({
        where: {
          status: {
            in: ['PENDING', 'PROCESSING'],
          },
        },
      });

      for (const job of activeJobs) {
        if (job.status === 'PENDING') {
          // Chuyển trạng thái sang PROCESSING và bắt đầu bước đầu tiên
          await this.prisma.videoJob.update({
            where: { id: job.id },
            data: {
              status: 'PROCESSING',
              progress: 10,
              stepDescription: 'Đang trích xuất âm thanh từ video...',
            },
          });
          this.logger.log(`Job ${job.id} chuyển từ PENDING sang PROCESSING`);
        } else if (job.status === 'PROCESSING') {
          let nextProgress = job.progress + 25;
          let nextStep = job.stepDescription;
          let nextStatus = 'PROCESSING';
          let subtitlesUrl = job.subtitlesUrl;

          if (nextProgress >= 100) {
            nextProgress = 100;
            nextStep = 'Hoàn tất! Phụ đề đã sẵn sàng tải xuống.';
            nextStatus = 'COMPLETED';
            subtitlesUrl = `/downloads/sub_${job.id}.srt`;

            // Khấu trừ 10 credits từ tài khoản người dùng khi hoàn tất dịch video
            try {
              const user = await this.prisma.user.update({
                where: { id: job.userId },
                data: {
                  credits: {
                    decrement: 10,
                  },
                },
              });
              this.logger.log(
                `Trừ thành công 10 credits cho video job của user: ${job.userId}. Số dư còn: ${user.credits}`,
              );
            } catch (err) {
              this.logger.error(
                `Lỗi khấu trừ credits cho user ${job.userId}:`,
                err,
              );
            }
          } else {
            // Định nghĩa các mô tả bước xử lý theo tiến độ
            if (nextProgress === 35) {
              nextStep =
                'Đang chuyển giọng nói thành văn bản (Speech-to-Text)...';
            } else if (nextProgress === 60) {
              nextStep = 'Đang dịch thuật phụ đề bằng AI Gemini...';
            } else if (nextProgress === 85) {
              nextStep = 'Đang render chèn cứng phụ đề vào video...';
            }
          }

          await this.prisma.videoJob.update({
            where: { id: job.id },
            data: {
              progress: nextProgress,
              stepDescription: nextStep,
              status: nextStatus,
              subtitlesUrl,
            },
          });

          this.logger.log(
            `Cập nhật tiến độ Job ${job.id}: ${nextProgress}% - Trạng thái: ${nextStatus}`,
          );
        }
      }
    } catch (err) {
      this.logger.error('Lỗi khi chạy hàng đợi xử lý Video:', err);
    } finally {
      this.isProcessing = false;
    }
  }
}
