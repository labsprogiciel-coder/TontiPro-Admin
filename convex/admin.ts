// convex/admin.ts — read models for the back-office dashboard
import { v } from "convex/values";
import { query, QueryCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { authz } from "./authz";

const DAY = 86_400_000;
const MONTHS = ["Jan", "Fév", "Mar", "Avr", "Mai", "Jun", "Jul", "Aoû", "Sep", "Oct", "Nov", "Déc"];

// Admin reads require a signed-in user. Until an auth provider is configured,
// a dev deployment can opt in to anonymous reads with:
//   npx convex env set ADMIN_ALLOW_ANONYMOUS true
// Never set this on a production deployment.
async function requireViewer(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (identity) return identity;
  if (process.env.ADMIN_ALLOW_ANONYMOUS === "true") return null;
  throw new Error("Unauthenticated");
}

function startOfMonth(now: number) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function startOfDay(now: number) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function byId<T extends { _id: string }>(rows: T[]) {
  return new Map(rows.map((r) => [r._id as string, r]));
}

const CUSTOMER_STATUS = {
  verified: "actif",
  prospect: "attente",
  rejected: "archive",
} as const;

const ROLE_LABELS: Record<string, string> = {
  field_agent: "Agent terrain",
  supervisor: "Superviseur",
  accountant: "Comptable",
  it_admin: "Admin IT",
};

async function loadAll(ctx: QueryCtx) {
  const [customers, users, branches, transactions, disbursements] = await Promise.all([
    ctx.db.query("customers").collect(),
    ctx.db.query("users").collect(),
    ctx.db.query("branches").collect(),
    ctx.db.query("transactions").collect(),
    ctx.db.query("disbursements").collect(),
  ]);
  return { customers, users, branches, transactions, disbursements };
}

type Ledger = Awaited<ReturnType<typeof loadAll>>;

function customerRows(data: Ledger, now: number) {
  const users = byId(data.users);
  const branches = byId(data.branches);
  const monthStart = startOfMonth(now);

  return data.customers.map((c) => {
    const txs = data.transactions.filter(
      (t) => t.customerId === c._id && t.status === "completed",
    );
    const balance = txs.reduce((s, t) => s + t.amount, 0);
    const lastTx = txs.reduce<number | null>(
      (m, t) => (m === null || t.timestamp > m ? t.timestamp : m),
      null,
    );
    const monthTotal = txs
      .filter((t) => t.timestamp >= monthStart)
      .reduce((s, t) => s + t.amount, 0);
    const branch = branches.get(c.branchId);
    return {
      id: c._id,
      name: c.fullName,
      phone: c.phoneNumber,
      idNumber: c.idNumber,
      status: CUSTOMER_STATUS[c.status],
      joined: c._creationTime,
      balance,
      txCount: txs.length,
      monthlyAvg: monthTotal,
      lastTx,
      agent: users.get(c.onboardedBy)?.fullName ?? "—",
      branch: branch?.name ?? "—",
      village: branch?.location.split(",")[0] ?? "—",
    };
  });
}

function movementRows(data: Ledger) {
  const customers = byId(data.customers);
  const users = byId(data.users);
  const branches = byId(data.branches);

  const collections = data.transactions.map((t) => ({
    id: t._id as string,
    kind: "transaction" as const,
    type: "in" as const,
    label: "Dépôt",
    amount: t.amount,
    timestamp: t.timestamp,
    customerId: t.customerId,
    client: customers.get(t.customerId)?.fullName ?? "—",
    agent: users.get(t.agentId)?.fullName ?? "—",
    branch: branches.get(t.branchId)?.name ?? "—",
    tpe: t.tpeId,
    channel: "TPE",
    status: t.status === "completed" ? "validée" : "annulée",
    reason: t.reversalReason ?? null,
    reversedBy: t.reversedBy ? users.get(t.reversedBy)?.fullName ?? null : null,
  }));

  const payouts = data.disbursements.map((d) => ({
    id: d._id as string,
    kind: "disbursement" as const,
    type: "out" as const,
    label: "Décaissement",
    amount: d.amount,
    timestamp: d.timestamp,
    customerId: d.customerId,
    client: customers.get(d.customerId)?.fullName ?? "—",
    agent: users.get(d.initiatedBy)?.fullName ?? "—",
    branch: branches.get(d.branchId)?.name ?? "—",
    tpe: "—",
    channel: d.payoutMethod === "mobile_money" ? "Mobile money" : "Agence",
    status:
      d.status === "pending"
        ? "en attente"
        : d.status === "rejected"
          ? "annulée"
          : "validée",
    reason: null,
    reversedBy: null,
  }));

  return [...collections, ...payouts].sort((a, b) => b.timestamp - a.timestamp);
}

export const dashboard = query({
  args: {},
  handler: async (ctx) => {
    await requireViewer(ctx);
    const now = Date.now();
    const data = await loadAll(ctx);
    const monthStart = startOfMonth(now);
    const prevMonthStart = startOfMonth(monthStart - 1);

    const completed = data.transactions.filter((t) => t.status === "completed");
    const paidOut = data.disbursements.filter(
      (d) => d.status === "approved" || d.status === "executed",
    );
    const sum = (xs: { amount: number }[]) => xs.reduce((s, x) => s + x.amount, 0);

    // Six-month volume, in thousands of FCFA
    const volume = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(monthStart);
      const from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1);
      const to = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i + 1, 1);
      const inRange = (t: number) => t >= from && t < to;
      volume.push({
        m: MONTHS[new Date(from).getUTCMonth()],
        in: Math.round(sum(completed.filter((t) => inRange(t.timestamp))) / 1000),
        out: Math.round(sum(paidOut.filter((p) => inRange(p.timestamp))) / 1000),
      });
    }

    const clients = customerRows(data, now)
      .sort((a, b) => (b.lastTx ?? 0) - (a.lastTx ?? 0))
      .slice(0, 5);

    return {
      kpis: {
        activeClients: data.customers.filter((c) => c.status === "verified").length,
        newClientsMonth: data.customers.filter((c) => c._creationTime >= monthStart).length,
        totalSavings: sum(completed),
        txMonth: completed.filter((t) => t.timestamp >= monthStart).length,
        txPrevMonth: completed.filter(
          (t) => t.timestamp >= prevMonthStart && t.timestamp < monthStart,
        ).length,
        pendingDisbursements: data.disbursements.filter((d) => d.status === "pending").length,
        pendingDisbursementsAmount: sum(
          data.disbursements.filter((d) => d.status === "pending"),
        ),
      },
      volume,
      clients,
      recent: movementRows(data).slice(0, 6),
      branchCount: data.branches.length,
      agentCount: data.users.length,
    };
  },
});

export const listCustomers = query({
  args: {},
  handler: async (ctx) => {
    await requireViewer(ctx);
    const data = await loadAll(ctx);
    return customerRows(data, Date.now());
  },
});

export const customerHistory = query({
  args: { customerId: v.id("customers") },
  handler: async (ctx, args) => {
    await requireViewer(ctx);
    const data = await loadAll(ctx);
    return movementRows(data)
      .filter((m) => m.customerId === args.customerId)
      .slice(0, 10);
  },
});

export const listMovements = query({
  args: { since: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireViewer(ctx);
    const data = await loadAll(ctx);
    const rows = movementRows(data);
    return args.since ? rows.filter((r) => r.timestamp >= args.since!) : rows;
  },
});

export const listAgents = query({
  args: {},
  handler: async (ctx) => {
    await requireViewer(ctx);
    const now = Date.now();
    const monthStart = startOfMonth(now);
    const [data, devices] = await Promise.all([
      loadAll(ctx),
      ctx.db.query("devices").collect(),
    ]);
    const branches = byId(data.branches);

    return Promise.all(
      data.users.map(async (u) => {
        const device = devices.find((d) => d.assignedTo === u._id) ?? null;
        const monthTx = data.transactions.filter(
          (t) => t.agentId === u._id && t.status === "completed" && t.timestamp >= monthStart,
        );
        let roles: string[] = [];
        try {
          roles = (await authz.getUserRoles(ctx, u.tokenIdentifier)).map((r) => r.role);
        } catch {
          // Role lookup is informative only; ignore component errors
        }
        return {
          id: u._id,
          name: u.fullName,
          phone: u.phoneNumber,
          email: u.email,
          branch: branches.get(u.branchId)?.name ?? "—",
          role: roles.map((r) => ROLE_LABELS[r] ?? r).join(", ") || "—",
          status: u.status,
          clients: data.customers.filter((c) => c.onboardedBy === u._id).length,
          collected: monthTx.reduce((s, t) => s + t.amount, 0),
          txMonth: monthTx.length,
          device: device && {
            serial: device.serialNumber,
            model: device.model,
            status: device.status,
            lastSync: device.lastSync,
          },
        };
      }),
    );
  },
});

export const listDevices = query({
  args: {},
  handler: async (ctx) => {
    await requireViewer(ctx);
    const [devices, users] = await Promise.all([
      ctx.db.query("devices").collect(),
      ctx.db.query("users").collect(),
    ]);
    const usersById = byId(users);
    return devices.map((d) => ({
      serial: d.serialNumber,
      model: d.model,
      status: d.status,
      lastSync: d.lastSync,
      assignedTo: d.assignedTo ?? null,
      assignee: d.assignedTo ? usersById.get(d.assignedTo)?.fullName ?? "—" : null,
      boundBy: d.boundBy ? usersById.get(d.boundBy)?.fullName ?? "—" : null,
      boundAt: d.boundAt ?? null,
    }));
  },
});

export const listReconciliations = query({
  args: {},
  handler: async (ctx) => {
    await requireViewer(ctx);
    const [recs, users, transactions, devices] = await Promise.all([
      ctx.db.query("reconciliations").order("desc").collect(),
      ctx.db.query("users").collect(),
      ctx.db.query("transactions").collect(),
      ctx.db.query("devices").collect(),
    ]);
    const usersById = byId(users);

    return recs.map((r) => {
      const dayStart = Date.parse(r.date + "T00:00:00Z");
      const dayTx = transactions.filter(
        (t) =>
          t.agentId === r.agentId &&
          t.status === "completed" &&
          t.timestamp >= dayStart &&
          t.timestamp < dayStart + DAY,
      );
      const device = devices.find((d) => d.assignedTo === r.agentId);
      return {
        id: r._id,
        agentId: r.agentId,
        date: r.date,
        agent: usersById.get(r.agentId)?.fullName ?? "—",
        verifiedBy: usersById.get(r.verifiedBy)?.fullName ?? "—",
        tpe: device?.serialNumber ?? "—",
        timestamp: r.timestamp,
        status: r.status,
        txCount: dayTx.length,
        expected: r.systemExpectedAmount,
        counted: r.physicalCashReceived,
        variance: r.variance,
        notes: r.notes ?? "",
      };
    });
  },
});

// Agents with completed collections today and no reconciliation yet —
// candidates for the end-of-day cash drop.
export const openSessions = query({
  args: {},
  handler: async (ctx) => {
    await requireViewer(ctx);
    const now = Date.now();
    const today = new Date(now).toISOString().split("T")[0];
    const dayStart = startOfDay(now);
    const [users, transactions, devices] = await Promise.all([
      ctx.db.query("users").collect(),
      ctx.db
        .query("transactions")
        .filter((q) => q.gte(q.field("timestamp"), dayStart))
        .collect(),
      ctx.db.query("devices").collect(),
    ]);

    const sessions = [];
    for (const u of users) {
      const txs = transactions.filter((t) => t.agentId === u._id && t.status === "completed");
      if (txs.length === 0) continue;
      const done = await ctx.db
        .query("reconciliations")
        .withIndex("by_agent_date", (q) => q.eq("agentId", u._id).eq("date", today))
        .first();
      if (done) continue;
      sessions.push({
        agentId: u._id as Id<"users">,
        agent: u.fullName,
        date: today,
        tpe: devices.find((d) => d.assignedTo === u._id)?.serialNumber ?? "—",
        opened: Math.min(...txs.map((t) => t.timestamp)),
        txCount: txs.length,
        expected: txs.reduce((s, t) => s + t.amount, 0),
      });
    }
    return sessions;
  },
});
