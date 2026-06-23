import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AdminGuard } from './admin.guard';

function buildContext(user: { role?: string } | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;
}

describe('AdminGuard', () => {
  const guard = new AdminGuard();

  it('allows a request whose user has role=ADMIN', () => {
    expect(guard.canActivate(buildContext({ role: 'ADMIN' }))).toBe(true);
  });

  it('rejects a non-admin role with 403', () => {
    expect(() => guard.canActivate(buildContext({ role: 'USER' }))).toThrow(
      ForbiddenException,
    );
  });

  it('rejects a request with no user attached', () => {
    expect(() => guard.canActivate(buildContext(undefined))).toThrow(
      ForbiddenException,
    );
  });
});
