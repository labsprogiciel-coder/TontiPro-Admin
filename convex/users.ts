// convex/users.ts — current staff member, and role administration
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { Doc } from "./_generated/dataModel";
import { internalMutation, MutationCtx, query, QueryCtx } from "./_generated/server";
import { authz } from "./authz";

export const ROLE = v.union(
  v.literal("field_agent"),
  v.literal("supervisor"),
  v.literal("accountant"),
  v.literal("it_admin"),
);

const ACTIVATION_TTL_MS = 48 * 60 * 60 * 1000;
// No 0/O/1/I so codes survive being read out over the phone
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export async function hashActivationCode(code: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// The signed-in, active staff member. Authz user IDs are users._id.
export async function requireUser(ctx: QueryCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Unauthenticated");
  const user = await ctx.db.get(userId);
  if (!user) throw new Error("User not found");
  if (user.status !== "active") throw new Error("Account suspended");
  return user;
}

export const me = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    if (!user) return null;
    if (user.status !== "active") return { id: user._id, name: user.fullName, active: false as const };
    const can = (permission: Parameters<typeof authz.can>[2]) =>
      authz.can(ctx, user._id, permission).catch(() => false);
    const [branch, roles, reverse, approve, liquidate, bind, manageStaff] = await Promise.all([
      ctx.db.get(user.branchId),
      authz.getUserRoles(ctx, user._id).catch(() => []),
      can("transactions:reverse"),
      can("disbursements:approve"),
      can("reconciliation:liquidate"),
      can("devices:bind"),
      can("staff:manage"),
    ]);
    return {
      id: user._id,
      active: true as const,
      name: user.fullName,
      email: user.email,
      branch: branch?.name ?? null,
      roles: roles.map((r) => r.role),
      // UI hints only: every mutation re-checks its own permission
      can: { reverse, approve, liquidate, bind, manageStaff },
    };
  },
});

// Bootstrap / admin tool: npx convex run users:assignRole '{"email":"…","role":"it_admin"}'
export const assignRole = internalMutation({
  args: { email: v.string(), role: ROLE },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", args.email.trim().toLowerCase()))
      .unique();
    if (!user) throw new Error("No staff account for this email");
    await authz.assignRole(ctx, user._id, args.role);
    return user._id;
  },
});

// Issue the one-time code a staff member needs for "Première connexion".
// Re-issuing replaces the previous code. Only the hash is stored.
//   npx convex run users:issueActivationCode '{"email":"…"}'
export const issueActivationCode = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", args.email.trim().toLowerCase()))
      .unique();
    if (!user) throw new Error("No staff account for this email");
    return createActivationCode(ctx, user);
  },
});

// Shared by the CLI mutation above and staff.issueActivationCode (UI)
export async function createActivationCode(ctx: MutationCtx, user: Doc<"users">) {
  if (user.status !== "active") throw new Error("Account suspended");
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const code = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  const expiresAt = Date.now() + ACTIVATION_TTL_MS;
  await ctx.db.patch(user._id, {
    activationCodeHash: await hashActivationCode(code),
    activationExpiresAt: expiresAt,
  });
  return { code, expiresAt: new Date(expiresAt).toISOString() };
}
