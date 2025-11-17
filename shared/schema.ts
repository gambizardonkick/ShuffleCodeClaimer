import { pgTable, serial, text, timestamp, integer, boolean, jsonb } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  telegramUserId: text('telegram_user_id').unique().notNull(),
  shuffleUsername: text('shuffle_username'),
  status: text('status').default('pending').notNull(), // pending, active, expired, suspended
  trialClaimedAt: timestamp('trial_claimed_at'), // Track when user claimed their 30-min free trial
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const plans = pgTable('plans', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  priceCents: integer('price_cents').notNull(),
  currency: text('currency').default('TRX').notNull(),
  durationDays: integer('duration_days').notNull(),
  maxCodesPerDay: integer('max_codes_per_day').default(10),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const subscriptions = pgTable('subscriptions', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id).notNull(),
  planId: integer('plan_id').references(() => plans.id).notNull(),
  status: text('status').default('pending').notNull(), // pending, active, expired, cancelled
  expiryAt: timestamp('expiry_at'),
  oxapayTrackId: text('oxapay_track_id'),
  oxapayOrderId: text('oxapay_order_id'),
  paidAmount: integer('paid_amount'),
  paidCurrency: text('paid_currency'),
  txId: text('tx_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const shuffleAccounts = pgTable('shuffle_accounts', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id).notNull(),
  username: text('username').notNull(),
  status: text('status').default('pending').notNull(), // pending, active, expired
  expiryAt: timestamp('expiry_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const authTokens = pgTable('auth_tokens', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id).notNull(),
  tokenType: text('token_type').notNull(), // shuffle_auth, shuffle_session
  tokenValue: text('token_value').notNull(), // encrypted
  validUntil: timestamp('valid_until'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const claimJobs = pgTable('claim_jobs', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id).notNull(),
  shuffleAccountId: integer('shuffle_account_id').references(() => shuffleAccounts.id),
  code: text('code').notNull(),
  status: text('status').default('pending').notNull(), // pending, processing, success, failed
  result: jsonb('result'), // { success: true/false, message: string, amount: number }
  error: text('error'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  processedAt: timestamp('processed_at'),
});

export const codes = pgTable('codes', {
  id: serial('id').primaryKey(),
  code: text('code').unique().notNull(),
  amount: text('amount'),
  wager: text('wager'),
  deadline: text('deadline'),
  claimed: boolean('claimed').default(false).notNull(),
  rejectionReason: text('rejection_reason'),
  claimedBy: integer('claimed_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  claimedAt: timestamp('claimed_at'),
});

export const authSessions = pgTable('auth_sessions', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id).notNull(),
  shuffleAccountId: integer('shuffle_account_id').references(() => shuffleAccounts.id).notNull(),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token').notNull(),
  deviceFingerprint: text('device_fingerprint'),
  expiryAt: timestamp('expiry_at').notNull(),
  lastActiveAt: timestamp('last_active_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const auditLogs = pgTable('audit_logs', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id),
  action: text('action').notNull(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
