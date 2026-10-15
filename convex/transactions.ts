// convex/transactions.ts
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { Doc } from "./_generated/dataModel";
import { mutation, query, QueryCtx } from "./_generated/server";
import { authz } from "./authz";
import { assignedDevice, requireUser } from "./users";

const MAX_DEPOSIT = 100_000_000; // sanity cap, in the branch currency

/** The UTC day (YYYY-MM-DD) of a timestamp, as reconciliation.ts files it. */
const utcDay = (ms: number) => new Date(ms).toISOString().split("T")[0];

/**
 * Record a cash deposit collected by the signed-in agent. Requires
 * transactions:collect. The agent, branch, TPE (the agent's bound device) and
 * time come from the server, never from arguments. `clientId` is the UUID the
 * app generated when it recorded the collection: replaying the same one
 * returns the deposit already stored instead of a second one. Throws
 * `INVALID_AMOUNT`, `CUSTOMER_NOT_FOUND` (unknown or another branch's),
 * `NO_DEVICE` (no active bound TPE), `DAY_CLOSED` (today's cash already
 * reconciled), `DUPLICATE_CLIENT_ID` (UUID used by another agent) or
 * `FORBIDDEN`.
 */
export const createDeposit = mutation({
  args: {
    customerId: v.id("customers"),
    amount: v.number(),
    clientId: v.string(),
  },
  handler: async (ctx, args) => {
    const agent = await requireUser(ctx);
    if (!(await authz.can(ctx, agent._id, "transactions:collect"))) {
      throw new ConvexError("FORBIDDEN");
    }
    const clientId = args.clientId.trim();
    if (!clientId || clientId.length > 64) throw new ConvexError("INVALID_CLIENT_ID");

    // Idempotent replay: checked first, so a deposit already stored is
    // returned even if the day has been closed since
    const previous = await ctx.db
      .query("transactions")
      .withIndex("by_client_id", (q) => q.eq("clientId", clientId))
      .first();
    if (previous) {
      if (previous.agentId !== agent._id) throw new ConvexError("DUPLICATE_CLIENT_ID");
      return previous._id;
    }

    if (!Number.isInteger(args.amount) || args.amount <= 0 || args.amount > MAX_DEPOSIT) {
      throw new ConvexError("INVALID_AMOUNT");
    }
    const customer = await ctx.db.get(args.customerId);
    if (!customer || customer.branchId !== agent.branchId) {
      throw new ConvexError("CUSTOMER_NOT_FOUND");
    }
    const device = await assignedDevice(ctx, agent._id);
    if (!device || device.status !== "active") throw new ConvexError("NO_DEVICE");

    const now = Date.now();
    const closed = await ctx.db
      .query("reconciliations")
      .withIndex("by_agent_date", (q) => q.eq("agentId", agent._id).eq("date", utcDay(now)))
      .first();
    if (closed) throw new ConvexError("DAY_CLOSED");

    const branch = await ctx.db.get(agent.branchId);
    const organization = branch ? await ctx.db.get(branch.organizationId) : null;
    return await ctx.db.insert("transactions", {
      amount: args.amount,
      currency: organization?.currency ?? "XOF",
      customerId: customer._id,
      agentId: agent._id,
      branchId: agent.branchId,
      tpeId: device.serialNumber,
      status: "completed",
      timestamp: now,
      clientId,
    });
  },
});

/** Shape of the caller's own collections for the mobile app. */
async function myRows(ctx: QueryCtx, rows: Doc<"transactions">[]) {
  const names = new Map<string, string>();
  for (const t of rows) {
    if (!names.has(t.customerId)) {
      names.set(t.customerId, (await ctx.db.get(t.customerId))?.fullName ?? "—");
    }
  }
  return rows.map((t) => ({
    _id: t._id,
    clientId: t.clientId ?? null,
    customerId: t.customerId,
    customerName: names.get(t.customerId)!,
    amount: t.amount,
    currency: t.currency,
    tpeId: t.tpeId,
    status: t.status,
    reversalReason: t.reversalReason ?? null,
    timestamp: t.timestamp,
  }));
}

/**
 * The signed-in agent's own collections, newest first (the last `limit`,
 * default 200). Empty when signed out: the app subscribes before its session
 * resolves.
 */
export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (!(await getAuthUserId(ctx))) return [];
    const agent = await requireUser(ctx);
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 200), 1), 1000);
    const rows = await ctx.db
      .query("transactions")
      .withIndex("by_agent_date", (q) => q.eq("agentId", agent._id))
      .order("desc")
      .take(limit);
    return myRows(ctx, rows);
  },
});

/**
 * The signed-in agent's own collections with `from <= timestamp < to` (ms),
 * newest first, e.g. today's for the end-of-day summary. Empty when signed out.
 */
export const listMineInRange = query({
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, args) => {
    if (!(await getAuthUserId(ctx))) return [];
    const agent = await requireUser(ctx);
    // timestamp is set from the server clock at insert, like _creationTime
    const rows = await ctx.db
      .query("transactions")
      .withIndex("by_agent_date", (q) =>
        q.eq("agentId", agent._id).gte("_creationTime", args.from - 60_000).lt("_creationTime", args.to + 60_000),
      )
      .order("desc")
      .collect();
    return myRows(
      ctx,
      rows.filter((t) => t.timestamp >= args.from && t.timestamp < args.to),
    );
  },
});

export const reverseTransaction = mutation({
  args: { transactionId: v.id("transactions"), reason: v.string() },
  handler: async (ctx, args) => {
    const supervisor = await requireUser(ctx);
    await authz.require(ctx, supervisor._id, "transactions:reverse");

    const tx = await ctx.db.get(args.transactionId);
    if (!tx) throw new Error("Transaction not found");
    if (tx.status === "reversed") throw new Error("Already reversed");

    // Block reversal if daily cash for this agent is already settled
    const txDate = new Date(tx.timestamp).toISOString().split("T")[0];
    const settled = await ctx.db
      .query("reconciliations")
      .withIndex("by_agent_date", (q) =>
        q.eq("agentId", tx.agentId).eq("date", txDate)
      )
      .filter((q) => q.eq(q.field("status"), "settled"))
      .first();
    if (settled) throw new Error("Cannot reverse: daily cash already settled");

    return await ctx.db.patch(args.transactionId, {
      status: "reversed",
      reversalReason: args.reason,
      reversedBy: supervisor._id,
    });
  },
});

/**
 * An agent's transactions, newest first. Agents may read their own history;
 * reading someone else's needs transactions:audit (supervisor, accountant)
 * and is limited to agents of the caller's branch.
 */
export const listByAgent = query({
  args: { agentId: v.id("users") },
  handler: async (ctx, args) => {
    const caller = await requireUser(ctx);
    if (args.agentId !== caller._id) {
      const agent = await ctx.db.get(args.agentId);
      const allowed =
        agent !== null &&
        agent.branchId === caller.branchId &&
        (await authz.can(ctx, caller._id, "transactions:audit"));
      if (!allowed) throw new ConvexError("FORBIDDEN");
    }
    return ctx.db
      .query("transactions")
      .withIndex("by_agent_date", (q) => q.eq("agentId", args.agentId))
      .order("desc")
      .collect();
  },
});

/**
 * A branch's transactions, newest first. Needs transactions:audit and is
 * limited to the caller's own branch.
 */
export const listByBranch = query({
  args: { branchId: v.id("branches") },
  handler: async (ctx, args) => {
    const caller = await requireUser(ctx);
    if (
      args.branchId !== caller.branchId ||
      !(await authz.can(ctx, caller._id, "transactions:audit"))
    ) {
      throw new ConvexError("FORBIDDEN");
    }
    return ctx.db
      .query("transactions")
      .withIndex("by_branch", (q) => q.eq("branchId", args.branchId))
      .order("desc")
      .collect();
  },
});
