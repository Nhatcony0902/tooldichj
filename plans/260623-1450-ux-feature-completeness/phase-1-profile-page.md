# Phase 1: Profile Page

**Effort:** M
**Depends on:** none (fully independent)
**Blocks:** none

## Goal

Give logged-in users a dedicated Profile/Settings tab to view and edit `name`, `phone`, `avatarUrl` (URL text field, per DEC-2), and change their password in-session (per DEC-3) — all fields already exist on `User` in `backend/prisma/schema.prisma`, no migration needed.

## Files owned by this phase

- `backend/src/auth/auth.controller.ts` — add `PATCH /auth/profile`, `PATCH /auth/change-password`
- `backend/src/auth/auth.service.ts` — add `updateProfile(userId, dto)`, `changePassword(userId, dto)`
- `backend/src/auth/dto/auth.dto.ts` — add `UpdateProfileDto { name?, phone?, avatarUrl? }`, `ChangePasswordDto { currentPassword, newPassword }`
- `backend/src/auth/auth.service.spec.ts` — add test cases
- `frontend/src/app/components/ProfileSection.tsx` — **new** component
- `frontend/src/app/page.tsx` — add `"profile"` to `activeTab` union + tab button + render branch
- `frontend/src/app/types/index.ts` — extend `User` interface with `phone?: string | null`, `avatarUrl?: string | null`

## Implementation notes

### Backend

`auth.service.ts::updateProfile`:
```ts
async updateProfile(userId: string, dto: UpdateProfileDto) {
  const data: Record<string, string> = {};
  if (dto.name !== undefined) data.name = dto.name.trim();
  if (dto.phone !== undefined) data.phone = dto.phone.trim();
  if (dto.avatarUrl !== undefined) data.avatarUrl = dto.avatarUrl.trim();
  const user = await this.prisma.user.update({ where: { id: userId }, data });
  return { id: user.id, name: user.name, phone: user.phone, avatarUrl: user.avatarUrl };
}
```

`auth.service.ts::changePassword` — mirror the existing `bcrypt.compare` check at line ~209 (login) and the `bcrypt.hash(newPassword, 10)` pattern at line ~498 (reset-password):
```ts
async changePassword(userId: string, dto: ChangePasswordDto) {
  const user = await this.prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundException('User not found');
  const valid = await bcrypt.compare(dto.currentPassword, user.password);
  if (!valid) throw new BadRequestException('Current password is incorrect');
  const hashed = await bcrypt.hash(dto.newPassword, 10);
  await this.prisma.user.update({ where: { id: userId }, data: { password: hashed } });
  return { success: true, message: 'Password changed successfully' };
}
```

Both endpoints `@UseGuards(JwtAuthGuard)`, controller delegates straight through (same thin-controller style as the rest of `auth.controller.ts`).

### Frontend

`ProfileSection.tsx` — same card-based layout as `MfaSettingsSection.tsx`/`BillingSection.tsx`:
- Form 1: name / phone / avatarUrl text inputs, pre-filled from `user` prop, `PATCH /auth/profile` on submit, calls `refreshUser(token)` after success, `showToast`.
- Form 2: current password / new password / confirm new password, `PATCH /auth/change-password` on submit, clears fields + `showToast` on success.
- If `avatarUrl` is set, render a small `<img>` preview (mirrors the `<img>` pattern already used in `BillingSection.tsx` for the QR code, same `eslint-disable-next-line @next/next/no-img-element` comment needed).

`page.tsx`:
- `const [activeTab, setActiveTab] = useState<"text" | "video" | "profile">("text");`
- Add a third tab button: `👤 Hồ sơ cá nhân`
- Add `{activeTab === "profile" && <ProfileSection token={token!} user={user} refreshUser={fetchUserMe} showToast={showToast} />}` alongside the existing text/video branch (Profile tab replaces the text/video board, same as how text/video already mutually exclude).

## Risk Assessment

| Risk | Likelihood | Impact | Score | Mitigation |
|------|-----------|--------|-------|------------|
| User submits empty `name` (required field elsewhere) | 2 | 2 | 4 | Backend rejects empty-string `name` after `.trim()` with `BadRequestException`; frontend `required` attribute on the input |
| `avatarUrl` is not a valid image URL (broken `<img>`) | 3 | 1 | 3 | `onError` handler on the `<img>` hides the broken-image icon, no validation needed beyond that — cosmetic only |

## Timeline

| Step | Effort |
|------|--------|
| Backend: DTOs + service methods + controller routes | S |
| Backend: tests in `auth.service.spec.ts` | S |
| Frontend: `ProfileSection.tsx` + `page.tsx` wiring | S |
| **Total** | **M** |

## Verification

1. `cd backend && npm run test -- auth.service.spec` — new `updateProfile`/`changePassword` tests pass, zero regressions in existing auth tests.
2. `cd backend && npm run start:dev`, then via curl or the running frontend: `PATCH /auth/profile` with a valid JWT updates name/phone/avatarUrl; `GET /auth/me` reflects the change.
3. `PATCH /auth/change-password` with wrong `currentPassword` → 400; with correct `currentPassword` → 200, then confirm login with the NEW password succeeds and the OLD password fails.
4. Manually click through: Profile tab renders, edit name → save → toast success → name updates in `Header` (which reads `user.name`).

## Rollback

Single-file reverts (no migration in this phase — all fields pre-existed): revert `auth.controller.ts`, `auth.service.ts`, `auth.dto.ts`, delete `ProfileSection.tsx`, revert `page.tsx` tab addition.
