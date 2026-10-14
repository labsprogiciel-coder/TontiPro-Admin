// convex/transactions.ts
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { authz } from "./authz";
import { requireUser } from "./users";

export const collectCash = mutation({
  args: {
    amount: v.number(),
    customerId: v.id("customers"),
    tpeId: v.string(),
    currency: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const agent = await requireUser(ctx);
    await authz.require(ctx, agent._id, "transactions:collect");

    const device = await ctx.db
      .query("devices")
      .withIndex("by_serial", (q) => q.eq("serialNumber", args.tpeId))
      .unique();
    if (!device || device.assignedTo !== agent._id) {
      throw new Error("TPE not bound to this agent");
    }

    return await ctx.db.insert("transactions", {
      amount: args.amount,
      currency: args.currency ?? "XOF",
      customerId: args.customerId,
      agentId: agent._id,
      branchId: agent.branchId,
      tpeId: args.tpeId,
      status: "completed",
      timestamp: Date.now(),
    });
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

export const listByAgent = query({
  args: { agentId: v.id("users") },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    return ctx.db
      .query("transactions")
      .withIndex("by_agent_date", (q) => q.eq("agentId", args.agentId))
      .order("desc")
      .collect();
  },
});

export const listByBranch = query({
  args: { branchId: v.id("branches") },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    return ctx.db
      .query("transactions")
      .withIndex("by_branch", (q) => q.eq("branchId", args.branchId))
      .order("desc")
      .collect();
  },
});
