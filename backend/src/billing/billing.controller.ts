import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from './admin.guard';
import { BillingService } from './billing.service';
import { CreateTopupDto } from './dto/create-topup.dto';

interface RequestWithUser {
  user: {
    id: string;
    email: string;
    role: string;
    credits: number;
  };
}

@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('topup')
  createTopup(@Body() dto: CreateTopupDto, @Request() req: RequestWithUser) {
    return this.billingService.createTopupRequest(req.user.id, dto.amount);
  }

  @UseGuards(JwtAuthGuard)
  @Get('my-requests')
  myRequests(@Request() req: RequestWithUser) {
    return this.billingService.listMine(req.user.id);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('admin/pending')
  pending() {
    return this.billingService.listPending();
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('admin/:id/confirm')
  confirm(@Param('id') id: string, @Request() req: RequestWithUser) {
    return this.billingService.confirmRequest(id, req.user.id);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('admin/:id/reject')
  reject(@Param('id') id: string, @Request() req: RequestWithUser) {
    return this.billingService.rejectRequest(id, req.user.id);
  }
}
