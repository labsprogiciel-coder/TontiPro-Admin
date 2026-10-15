// convex/staff.ts — staff administration from the UI (staff:manage, it_admin)
import { ConvexError, v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { mutation, MutationCtx, query, QueryCtx } from "./_generated/server";
import { authz } from "./authz";
import { createActivationCode, requireUser, ROLE } from "./users";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Return the signed-in staff member if they hold `staff:manage`; throw otherwise. */
async function requireStaffAdmin(ctx: QueryCtx) {
  const actor = await requireUser(ctx);
  await authz.require(ctx, actor._id, "staff:manage");
  return actor;
}

/**
 * Load the staff member being changed. Throws `SELF_CHANGE` so an admin can't lock themselves out (own role or status), and `NOT_FOUND` if the user doesn't exist.
 */
async function getTarget(ctx: QueryCtx, actorId: Id<"users">, userId: Id<"users">) {
  // Guard against an admin locking themselves out (own role or status)
  if (userId === actorId) throw new ConvexError("SELF_CHANGE");
  const user = await ctx.db.get(userId);
  if (!user) throw new ConvexError("NOT_FOUND");
  return user;
}

/** List branches (id, name) for the new-staff form. Any signed-in staff member may read it. */
export const listBranches = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const branches = await ctx.db.query("branches").collect();
    return branches.map((b) => ({ id: b._id, name: b.name }));
  },
});

/**
 * Admin-only detail for the staff drawer: profile, roles, whether a password is set, the pending activation code's expiry, and whether it's the caller's own account.
 */
export const get = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const actor = await requireStaffAdmin(ctx);
    const user = await ctx.db.get(args.userId);
    if (!user) return null;
    const [roles, account, branch] = await Promise.all([
      authz.getUserRoles(ctx, user._id).catch(() => []),
      ctx.db
        .query("authAccounts")
        .withIndex("userIdAndProvider", (q) => q.eq("userId", user._id).eq("provider", "password"))
        .first(),
      ctx.db.get(user.branchId),
    ]);
    return {
      id: user._id,
      name: user.fullName,
      email: user.email,
      phone: user.phoneNumber,
      branch: branch?.name ?? "—",
      status: user.status,
      roles: roles.map((r) => r.role),
      activated: !!account,
      codePendingUntil:
        user.activationExpiresAt && user.activationExpiresAt > Date.now() ? user.activationExpiresAt : null,
      isSelf: user._id === actor._id,
    };
  },
});

/**
 * Create a staff member with one role. Validates the input and rejects a duplicate email (case-insensitive). Returns the new user ID; the account is activated later with a code from `issueActivationCode`.
 */
export const create = mutation({
  args: {
    fullName: v.string(),
    email: v.string(),
    phoneNumber: v.string(),
    branchId: v.id("branches"),
    role: ROLE,
  },
  handler: async (ctx, args) => {
    await requireStaffAdmin(ctx);
    const fullName = args.fullName.trim();
    const email = args.email.trim().toLowerCase();
    const phoneNumber = args.phoneNumber.trim();
    if (!fullName) throw new ConvexError("NAME_REQUIRED");
    if (!EMAIL_RE.test(email)) throw new ConvexError("INVALID_EMAIL");
    if (!phoneNumber) throw new ConvexError("PHONE_REQUIRED");
    if (!(await ctx.db.get(args.branchId))) throw new ConvexError("BRANCH_NOT_FOUND");
    const existing = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .first();
    if (existing) throw new ConvexError("EMAIL_TAKEN");

    const userId = await ctx.db.insert("users", {
      fullName, email, phoneNumber, branchId: args.branchId, status: "active",
    });
    await authz.assignRole(ctx, userId, args.role);
    return userId;
  },
});

/** Replace a staff member's roles with `role`. Refused on the caller's own account. */
export const setRole = mutation({
  args: { userId: v.id("users"), role: ROLE },
  handler: async (ctx, args) => {
    const actor = await requireStaffAdmin(ctx);
    const user = await getTarget(ctx, actor._id, args.userId);
    await authz.revokeAllRoles(ctx, user._id);
    await authz.assignRole(ctx, user._id, args.role);
  },
});

/**
 * Delete every auth session of `userId` and its refresh tokens, signing them out on all devices.
 */
async function endSessions(ctx: MutationCtx, userId: Id<"users">) {
  const sessions = await ctx.db
    .query("authSessions")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .collect();
  for (const session of sessions) {
    const tokens = await ctx.db
      .query("authRefreshTokens")
      .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
      .collect();
    await Promise.all(tokens.map((t) => ctx.db.delete(t._id)));
    await ctx.db.delete(session._id);
  }
}

/**
 * Suspend or reactivate a staff member. Suspending signs them out everywhere and voids any pending activation code. Refused on the caller's own account.
 */
export const setStatus = mutation({
  args: { userId: v.id("users"), status: v.union(v.literal("active"), v.literal("suspended")) },
  handler: async (ctx, args) => {
    const actor = await requireStaffAdmin(ctx);
    const user = await getTarget(ctx, actor._id, args.userId);
    if (args.status === "suspended") {
      // Signs the person out everywhere and voids any pending activation code
      await ctx.db.patch(user._id, {
        status: "suspended", activationCodeHash: undefined, activationExpiresAt: undefined,
      });
      await endSessions(ctx, user._id);
    } else {
      await ctx.db.patch(user._id, { status: "active" });
    }
  },
});

/**
 * Issue a new one-time activation code, replacing any pending one. Returns the plain code once; only its hash is stored. Refused for activated or suspended accounts.
 */
export const issueActivationCode = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    await requireStaffAdmin(ctx);
    const user = await ctx.db.get(args.userId);
    if (!user) throw new ConvexError("NOT_FOUND");
    const account = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", user._id).eq("provider", "password"))
      .first();
    if (account) throw new ConvexError("ALREADY_ACTIVATED");
    if (user.status !== "active") throw new ConvexError("SUSPENDED");
    return createActivationCode(ctx, user);
  },
});
