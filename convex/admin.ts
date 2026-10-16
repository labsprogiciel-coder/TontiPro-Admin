// convex/admin.ts — read models for the back-office dashboard
import { ConvexError, v } from "convex/values";
import { query, QueryCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { authz } from "./authz";
import { isWithdrawal, signedAmount } from "./transactions";
import { requireUser } from "./users";

const DAY = 86_400_000;
const MONTHS = ["Jan", "Fév", "Mar", "Avr", "Mai", "Jun", "Jul", "Aoû", "Sep", "Oct", "Nov", "Déc"];

/** The branch a read is limited to, or null for every branch. */
type Scope = Id<"branches"> | null;

/**
 * Customer and money reads are for the back office: they need
 * transactions:audit (supervisor, accountant) and cover the caller's branch
 * only. Anyone else (field agents, IT admins) gets FORBIDDEN.
 */
async function requireAuditor(ctx: QueryCtx): Promise<Id<"branches">> {
  const user = await requireUser(ctx);
  if (!(await authz.can(ctx, user._id, "transactions:audit"))) {
    throw new ConvexError("FORBIDDEN");
  }
  return user.branchId;
}

/**
 * The staff and TPE lists (Agents page): IT admins (staff:manage or
 * devices:bind) see every branch, auditors their own branch, others nothing.
 */
async function requireStaffViewer(ctx: QueryCtx): Promise<Scope> {
  const user = await requireUser(ctx);
  const [manage, bind, audit] = await Promise.all([
    authz.can(ctx, user._id, "staff:manage"),
    authz.can(ctx, user._id, "devices:bind"),
    authz.can(ctx, user._id, "transactions:audit"),
  ]);
  if (manage || bind) return null;
  if (audit) return user.branchId;
  throw new ConvexError("FORBIDDEN");
}

/** UTC timestamp of the first day of `now`'s month. */
function startOfMonth(now: number) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** UTC timestamp of midnight on `now`'s day. */
function startOfDay(now: number) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Index rows by `_id` for lookups. */
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

/**
 * Load the customers, users, branches, transactions and disbursements of one
 * branch (or of every branch for a null scope) for the read models below.
 */
async function loadAll(ctx: QueryCtx, scope: Scope) {
  if (scope === null) {
    const [customers, users, branches, transactions, disbursements] = await Promise.all([
      ctx.db.query("customers").collect(),
      ctx.db.query("users").collect(),
      ctx.db.query("branches").collect(),
      ctx.db.query("transactions").collect(),
      ctx.db.query("disbursements").collect(),
    ]);
    return { customers, users, branches, transactions, disbursements };
  }
  const [customers, users, branch, transactions, disbursements] = await Promise.all([
    ctx.db.query("customers").withIndex("by_branch", (q) => q.eq("branchId", scope)).collect(),
    ctx.db.query("users").filter((q) => q.eq(q.field("branchId"), scope)).collect(),
    ctx.db.get(scope),
    ctx.db.query("transactions").withIndex("by_branch", (q) => q.eq("branchId", scope)).collect(),
    ctx.db.query("disbursements").filter((q) => q.eq(q.field("branchId"), scope)).collect(),
  ]);
  return { customers, users, branches: branch ? [branch] : [], transactions, disbursements };
}

type Ledger = Awaited<ReturnType<typeof loadAll>>;

/**
 * Customer list rows with balance (deposits minus withdrawals), transaction count, this month's deposits, last activity, onboarding agent and branch.
 */
function customerRows(data: Ledger, now: number) {
  const users = byId(data.users);
  const branches = byId(data.branches);
  const monthStart = startOfMonth(now);

  return data.customers.map((c) => {
    const txs = data.transactions.filter(
      (t) => t.customerId === c._id && t.status === "completed",
    );
    const balance = txs.reduce((s, t) => s + signedAmount(t), 0);
    const lastTx = txs.reduce<number | null>(
      (m, t) => (m === null || t.timestamp > m ? t.timestamp : m),
      null,
    );
    const monthTotal = txs
      .filter((t) => !isWithdrawal(t) && t.timestamp >= monthStart)
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
      productId: c.productId ?? null,
      branch: branch?.name ?? "—",
      village: branch?.location.split(",")[0] ?? "—",
    };
  });
}

/** Deposits, withdrawals and disbursements merged into one movement list, newest first. */
function movementRows(data: Ledger) {
  const customers = byId(data.customers);
  const users = byId(data.users);
  const branches = byId(data.branches);

  const collections = data.transactions.map((t) => ({
    id: t._id as string,
    kind: "transaction" as const,
    type: isWithdrawal(t) ? ("out" as const) : ("in" as const),
    label: t.overdraft ? "Retrait (découvert)" : isWithdrawal(t) ? "Retrait" : "Dépôt",
    // Offline withdrawal that took the customer's balance below zero
    overdraft: t.overdraft === true,
    amount: t.amount,
    timestamp: t.timestamp,
    customerId: t.customerId,
    client: customers.get(t.customerId)?.fullName ?? "—",
    // An imported row's agent is the importer; show the name from the file
    agent: t.imported
      ? t.importedAgentName ?? `${users.get(t.agentId)?.fullName ?? "—"} (import)`
      : users.get(t.agentId)?.fullName ?? "—",
    branch: branches.get(t.branchId)?.name ?? "—",
    tpe: t.imported ? "—" : t.tpeId,
    channel: t.imported ? "Import" : "TPE",
    status: t.status === "completed" ? "validée" : "annulée",
    reason: t.reversalReason ?? null,
    reversedBy: t.reversedBy ? users.get(t.reversedBy)?.fullName ?? null : null,
  }));

  const payouts = data.disbursements.map((d) => ({
    id: d._id as string,
    kind: "disbursement" as const,
    type: "out" as const,
    label: "Décaissement",
    overdraft: false,
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

/** Dashboard KPIs, six-month volume, the five most recently active clients and the latest movements. */
export const dashboard = query({
  args: {},
  handler: async (ctx) => {
    const branchId = await requireAuditor(ctx);
    const now = Date.now();
    const data = await loadAll(ctx, branchId);
    const monthStart = startOfMonth(now);
    const prevMonthStart = startOfMonth(monthStart - 1);

    const completed = data.transactions.filter((t) => t.status === "completed");
    const deposits = completed.filter((t) => !isWithdrawal(t));
    const withdrawals = completed.filter(isWithdrawal);
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
        in: Math.round(sum(deposits.filter((t) => inRange(t.timestamp))) / 1000),
        out: Math.round(
          (sum(paidOut.filter((p) => inRange(p.timestamp))) +
            sum(withdrawals.filter((t) => inRange(t.timestamp)))) /
            1000,
        ),
      });
    }

    const clients = customerRows(data, now)
      .sort((a, b) => (b.lastTx ?? 0) - (a.lastTx ?? 0))
      .slice(0, 5);

    return {
      kpis: {
        activeClients: data.customers.filter((c) => c.status === "verified").length,
        newClientsMonth: data.customers.filter((c) => c._creationTime >= monthStart).length,
        totalSavings: sum(deposits) - sum(withdrawals),
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

/** The branch's customers with balances and activity for the Clients page. */
export const listCustomers = query({
  args: {},
  handler: async (ctx) => {
    const data = await loadAll(ctx, await requireAuditor(ctx));
    return customerRows(data, Date.now());
  },
});

/** The 10 most recent movements of one customer of the caller's branch. */
export const customerHistory = query({
  args: { customerId: v.id("customers") },
  handler: async (ctx, args) => {
    const branchId = await requireAuditor(ctx);
    const customer = await ctx.db.get(args.customerId);
    if (!customer || customer.branchId !== branchId) throw new ConvexError("FORBIDDEN");
    const data = await loadAll(ctx, branchId);
    return movementRows(data)
      .filter((m) => m.customerId === args.customerId)
      .slice(0, 10);
  },
});

/** The branch's movements, optionally only those since `since`. */
export const listMovements = query({
  args: { since: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const data = await loadAll(ctx, await requireAuditor(ctx));
    const rows = movementRows(data);
    return args.since ? rows.filter((r) => r.timestamp >= args.since!) : rows;
  },
});

/**
 * Staff with role, branch, assigned TPE and this month's collections for the
 * Agents page: every branch for IT admins, the caller's branch for auditors.
 */
export const listAgents = query({
  args: {},
  handler: async (ctx) => {
    const scope = await requireStaffViewer(ctx);
    const now = Date.now();
    const monthStart = startOfMonth(now);
    const [data, devices] = await Promise.all([
      loadAll(ctx, scope),
      ctx.db.query("devices").collect(),
    ]);
    const branches = byId(data.branches);

    return Promise.all(
      data.users.map(async (u) => {
        const device = devices.find((d) => d.assignedTo === u._id) ?? null;
        const monthTx = data.transactions.filter(
          (t) =>
            t.agentId === u._id && t.status === "completed" && !t.imported && t.timestamp >= monthStart,
        );
        let roles: string[] = [];
        let canCollect = false;
        try {
          roles = (await authz.getUserRoles(ctx, u._id)).map((r) => r.role);
          canCollect = await authz.can(ctx, u._id, "transactions:collect");
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
          roleKeys: roles,
          status: u.status,
          canCollect,
          clients: data.customers.filter((c) => c.onboardedBy === u._id).length,
          collected: monthTx.filter((t) => !isWithdrawal(t)).reduce((s, t) => s + t.amount, 0),
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

/**
 * The TPE fleet with assignee and last binding actor names: every device for
 * IT admins, the devices bound to the branch's staff for auditors.
 */
export const listDevices = query({
  args: {},
  handler: async (ctx) => {
    const scope = await requireStaffViewer(ctx);
    const [devices, users] = await Promise.all([
      ctx.db.query("devices").collect(),
      ctx.db.query("users").collect(),
    ]);
    const usersById = byId(users);
    const visible =
      scope === null
        ? devices
        : devices.filter((d) => {
            const owner = d.assignedTo ?? d.requestedBy;
            return owner && usersById.get(owner)?.branchId === scope;
          });
    return visible.map((d) => ({
      serial: d.serialNumber,
      model: d.model,
      status: d.status,
      lastSync: d.lastSync,
      assignedTo: d.assignedTo ?? null,
      assignee: d.assignedTo ? usersById.get(d.assignedTo)?.fullName ?? "—" : null,
      boundBy: d.boundBy ? usersById.get(d.boundBy)?.fullName ?? "—" : null,
      boundAt: d.boundAt ?? null,
      // Pending "liaison" request from an agent's phone (devices:registerMine)
      requestedBy: d.assignedTo ? null : d.requestedBy ?? null,
      requester: !d.assignedTo && d.requestedBy ? usersById.get(d.requestedBy)?.fullName ?? "—" : null,
      requestedAt: d.assignedTo ? null : d.requestedAt ?? null,
    }));
  },
});

/** The branch's end-of-day reconciliations with the day's collection count and TPE. */
export const listReconciliations = query({
  args: {},
  handler: async (ctx) => {
    const branchId = await requireAuditor(ctx);
    const [recs, users, transactions, devices] = await Promise.all([
      ctx.db
        .query("reconciliations")
        .order("desc")
        .filter((q) => q.eq(q.field("branchId"), branchId))
        .collect(),
      ctx.db.query("users").collect(),
      ctx.db.query("transactions").withIndex("by_branch", (q) => q.eq("branchId", branchId)).collect(),
      ctx.db.query("devices").collect(),
    ]);
    const usersById = byId(users);

    return recs.map((r) => {
      const dayStart = Date.parse(r.date + "T00:00:00Z");
      const dayTx = transactions.filter(
        (t) =>
          t.agentId === r.agentId &&
          t.status === "completed" &&
          !t.imported &&
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

/**
 * The branch's agents with completed collections today and no reconciliation yet — candidates for the end-of-day cash drop.
 */
export const openSessions = query({
  args: {},
  handler: async (ctx) => {
    const branchId = await requireAuditor(ctx);
    const now = Date.now();
    const today = new Date(now).toISOString().split("T")[0];
    const dayStart = startOfDay(now);
    const [users, transactions, devices] = await Promise.all([
      ctx.db.query("users").filter((q) => q.eq(q.field("branchId"), branchId)).collect(),
      ctx.db
        .query("transactions")
        .withIndex("by_branch", (q) => q.eq("branchId", branchId))
        .filter((q) => q.gte(q.field("timestamp"), dayStart))
        .collect(),
      ctx.db.query("devices").collect(),
    ]);

    const sessions = [];
    for (const u of users) {
      const txs = transactions.filter(
        (t) => t.agentId === u._id && t.status === "completed" && !t.imported,
      );
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
        expected: txs.reduce((s, t) => s + signedAmount(t), 0),
      });
    }
    return sessions;
  },
});
