const MONEY_SCALE = 1_000_000n;
const CENT_SCALE = 10_000n;
const MAX_RENEWLET_PAGES = 100;

export type RenewletTransactionType = 'expense' | 'income' | 'refund';

export interface RenewletTransaction {
  id: string;
  type: RenewletTransactionType;
  amount: string;
  currency: string;
  occurredAt: string;
  category: string;
  merchant: string | null;
}

export interface RenewletTransactionList {
  transactions: RenewletTransaction[];
  nextCursor: string | null;
  total: number;
}

export interface RenewletReportBasis {
  month: string;
  base: 'USD';
  rates: Readonly<Record<string, number>>;
  sourceDate: string;
  capturedAt: string | null;
}

export interface MonthlyRange {
  month: string;
  monthLabel: string;
  from: string;
  to: string;
}

export interface MonthlyCategoryRow {
  visible: boolean;
  name: string;
  amount: string;
  share_text: string;
}

export interface MonthlyFinanceData extends Record<string, unknown> {
  month_label: string;
  currency: string;
  net_amount_text: string;
  transaction_count_text: string;
  expense_amount: string;
  income_amount: string;
  refund_amount: string;
  category1: MonthlyCategoryRow;
  category2: MonthlyCategoryRow;
  category3: MonthlyCategoryRow;
  show_empty_expenses: boolean;
  coverage_text: string;
  updated_text: string;
}

export interface RecentExpenseRow {
  visible: boolean;
  date: string;
  merchant: string;
  category: string;
  amount: string;
}

export interface RecentFinanceData extends Record<string, unknown> {
  updated_text: string;
  summary_text: string;
  row1: RecentExpenseRow;
  row2: RecentExpenseRow;
  row3: RecentExpenseRow;
  row4: RecentExpenseRow;
  row5: RecentExpenseRow;
  show_empty: boolean;
  source_text: string;
}

type RenewletFetchJSON = (url: string, init: RequestInit, label: string) => Promise<unknown>;

export function normalizeRenewletBase(raw: string): string {
  return normalizeProtectedOrigin(raw, 'RENEWLET_BASE');
}

export function normalizeSlateBase(raw: string): string {
  return normalizeProtectedOrigin(raw, 'SLATE_API_BASE');
}

function normalizeProtectedOrigin(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new Error(`${name} must be an absolute HTTP(S) URL.`, { cause: error });
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must use HTTP or HTTPS.`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must not contain credentials, query parameters, or fragments.`);
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(`${name} must be an origin without a path.`);
  }
  if (url.protocol === 'http:' && !isPrivateOrContainerHostname(url.hostname)) {
    throw new Error(
      `${name} may use plain HTTP only for a private, loopback, or Docker-internal host.`
    );
  }

  return url.origin;
}

export function currentMonthlyRange(now: Date, timeZone: string): MonthlyRange {
  const local = datePartsInTimeZone(now, timeZone);
  const next =
    local.month === 12
      ? { year: local.year + 1, month: 1 }
      : { year: local.year, month: local.month + 1 };
  const start = localMidnightToInstant(local.year, local.month, 1, timeZone);
  const end = localMidnightToInstant(next.year, next.month, 1, timeZone);
  const month = `${local.year}-${String(local.month).padStart(2, '0')}`;
  return {
    month,
    monthLabel: `${local.year}年${local.month}月`,
    from: start.toISOString(),
    to: new Date(end.getTime() - 1).toISOString(),
  };
}

export async function fetchAllRenewletTransactions(input: {
  base: string;
  token: string;
  from: string;
  to: string;
  fetchJSON: RenewletFetchJSON;
}): Promise<RenewletTransactionList> {
  const transactions: RenewletTransaction[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < MAX_RENEWLET_PAGES; page += 1) {
    const result = await fetchRenewletTransactionsPage({
      ...input,
      query: {
        limit: '100',
        from: input.from,
        to: input.to,
        ...(cursor ? { cursor } : {}),
      },
    });
    transactions.push(...result.transactions);
    if (!result.nextCursor) {
      return { transactions, nextCursor: null, total: result.total };
    }
    if (seenCursors.has(result.nextCursor)) {
      throw new Error('Renewlet transaction pagination repeated a cursor.');
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }

  throw new Error(`Renewlet transaction pagination exceeded ${MAX_RENEWLET_PAGES} pages.`);
}

export async function fetchRecentRenewletExpenses(input: {
  base: string;
  token: string;
  fetchJSON: RenewletFetchJSON;
}): Promise<RenewletTransactionList> {
  return fetchRenewletTransactionsPage({
    ...input,
    query: { limit: '5', type: 'expense' },
  });
}

export async function fetchRenewletReportBasis(input: {
  base: string;
  token: string;
  month: string;
  fetchJSON: RenewletFetchJSON;
}): Promise<RenewletReportBasis> {
  const url = new URL('/api/hermes/v1/reporting/exchange-rate-snapshots', `${input.base}/`);
  url.searchParams.set('from', input.month);
  url.searchParams.set('to', input.month);
  const raw = await input.fetchJSON(
    url.toString(),
    {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.token}`,
      },
    },
    'Renewlet report exchange-rate basis'
  );
  return parseRenewletReportBasis(raw, input.month);
}

export function parseRenewletReportBasisConfig(raw: string, month: string): RenewletReportBasis {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error('RENEWLET_REPORT_BASIS_JSON must contain valid JSON.', { cause: error });
  }
  return parseReportBasisFields(
    record(value, 'Renewlet configured exchange-rate snapshot'),
    month,
    false
  );
}

export function buildMonthlyFinanceData(input: {
  transactions: readonly RenewletTransaction[];
  total: number;
  range: MonthlyRange;
  reportingCurrency: string;
  reportBasis: RenewletReportBasis | null;
  updatedAt: Date;
  timeZone: string;
}): MonthlyFinanceData {
  let expense = 0n;
  let income = 0n;
  let refund = 0n;
  const expenseByCategory = new Map<string, bigint>();

  for (const transaction of input.transactions) {
    const units = convertedMoneyUnits(
      transaction.amount,
      transaction.currency,
      input.reportingCurrency,
      input.reportBasis
    );
    if (transaction.type === 'expense') {
      expense += units;
      expenseByCategory.set(
        transaction.category,
        (expenseByCategory.get(transaction.category) ?? 0n) + units
      );
    } else if (transaction.type === 'income') {
      income += units;
    } else {
      refund += units;
    }
  }

  const categories = [...expenseByCategory.entries()]
    .sort(([leftName, leftAmount], [rightName, rightAmount]) => {
      if (leftAmount !== rightAmount) return leftAmount > rightAmount ? -1 : 1;
      return leftName.localeCompare(rightName, 'zh-CN');
    })
    .slice(0, 3)
    .map(([name, amount]) => categoryRow(name, amount, expense));
  while (categories.length < 3) categories.push(hiddenCategoryRow());

  return {
    month_label: input.range.monthLabel,
    currency: input.reportingCurrency,
    net_amount_text: `${input.reportingCurrency} ${formatSignedUnits(income + refund - expense)}`,
    transaction_count_text: `${input.total} 笔实际流水`,
    expense_amount: formatUnits(expense),
    income_amount: formatUnits(income),
    refund_amount: formatUnits(refund),
    category1: categories[0]!,
    category2: categories[1]!,
    category3: categories[2]!,
    show_empty_expenses: expense === 0n,
    coverage_text: input.reportBasis
      ? `${input.reportingCurrency} · 锁定汇率 ${input.reportBasis.sourceDate} · ${input.transactions.length}/${input.total} 笔`
      : `${input.reportingCurrency} · 无需汇率换算 · ${input.transactions.length}/${input.total} 笔`,
    updated_text: `更新 ${formatUpdatedAt(input.updatedAt, input.timeZone)}`,
  };
}

export function transactionsNeedReportBasis(
  transactions: readonly RenewletTransaction[],
  reportingCurrency: string
): boolean {
  return transactions.some((transaction) => transaction.currency !== reportingCurrency);
}

export function buildRecentFinanceData(input: {
  transactions: readonly RenewletTransaction[];
  updatedAt: Date;
  timeZone: string;
}): RecentFinanceData {
  const expenses = input.transactions
    .filter((transaction) => transaction.type === 'expense')
    .toSorted(
      (left, right) =>
        right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id)
    )
    .slice(0, 5);
  const rows = expenses.map((transaction) => recentRow(transaction, input.timeZone));
  while (rows.length < 5) rows.push(hiddenRecentRow());

  return {
    updated_text: `更新 ${formatUpdatedAt(input.updatedAt, input.timeZone)}`,
    summary_text:
      expenses.length > 0 ? `最近 ${expenses.length} 笔 · 按发生时间倒序` : '等待第一笔实际消费',
    row1: rows[0]!,
    row2: rows[1]!,
    row3: rows[2]!,
    row4: rows[3]!,
    row5: rows[4]!,
    show_empty: expenses.length === 0,
    source_text: '来源 Renewlet',
  };
}

async function fetchRenewletTransactionsPage(input: {
  base: string;
  token: string;
  query: Record<string, string>;
  fetchJSON: RenewletFetchJSON;
}): Promise<RenewletTransactionList> {
  const url = new URL('/api/hermes/v1/transactions', `${input.base}/`);
  for (const [key, value] of Object.entries(input.query)) url.searchParams.set(key, value);
  const raw = await input.fetchJSON(
    url.toString(),
    {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.token}`,
      },
    },
    'Renewlet transactions'
  );
  return parseRenewletTransactionList(raw);
}

function parseRenewletTransactionList(raw: unknown): RenewletTransactionList {
  const envelope = record(raw, 'Renewlet response');
  const payload = envelope.ok === true ? record(envelope.data, 'Renewlet response data') : envelope;
  if (!Array.isArray(payload.transactions)) {
    throw new Error('Renewlet response data.transactions must be an array.');
  }
  const nextCursor = payload.nextCursor;
  const total = payload.total;
  if (nextCursor !== null && typeof nextCursor !== 'string') {
    throw new Error('Renewlet response data.nextCursor must be a string or null.');
  }
  if (!Number.isInteger(total) || (total as number) < 0) {
    throw new Error('Renewlet response data.total must be a non-negative integer.');
  }
  return {
    transactions: payload.transactions.map((value, index) => parseTransaction(value, index)),
    nextCursor,
    total: total as number,
  };
}

function parseRenewletReportBasis(raw: unknown, month: string): RenewletReportBasis {
  const envelope = record(raw, 'Renewlet response');
  const payload = envelope.ok === true ? record(envelope.data, 'Renewlet response data') : envelope;
  if (!Array.isArray(payload.snapshots)) {
    throw new Error('Renewlet response data.snapshots must be an array.');
  }
  const matching = payload.snapshots.filter((snapshot) => {
    const value = record(snapshot, 'Renewlet exchange-rate snapshot');
    return value.month === month;
  });
  if (matching.length !== 1) {
    throw new Error(`Renewlet has no unique locked exchange-rate snapshot for ${month}.`);
  }
  const value = record(matching[0], 'Renewlet exchange-rate snapshot');
  return parseReportBasisFields(value, month, true);
}

function parseReportBasisFields(
  value: Record<string, unknown>,
  month: string,
  requireCapturedAt: boolean
): RenewletReportBasis {
  if (value.month !== month) {
    throw new Error(`Renewlet has no unique locked exchange-rate snapshot for ${month}.`);
  }
  if (value.base !== 'USD') {
    throw new Error('Renewlet exchange-rate snapshot base must be USD.');
  }
  const ratesRecord = record(value.rates, 'Renewlet exchange-rate snapshot rates');
  const rates: Record<string, number> = {};
  for (const [currency, rate] of Object.entries(ratesRecord)) {
    if (
      !/^[A-Z]{3}$/.test(currency) ||
      typeof rate !== 'number' ||
      !Number.isFinite(rate) ||
      rate <= 0
    ) {
      throw new Error(`Renewlet exchange-rate snapshot rate ${currency} is invalid.`);
    }
    rates[currency] = rate;
  }
  if (rates.USD !== 1) {
    throw new Error('Renewlet exchange-rate snapshot USD rate must be 1.');
  }
  const sourceDate = stringValue(value.sourceDate, 'Renewlet exchange-rate snapshot sourceDate');
  const capturedAt = requireCapturedAt
    ? stringValue(value.capturedAt, 'Renewlet exchange-rate snapshot capturedAt')
    : null;
  if (capturedAt && Number.isNaN(Date.parse(capturedAt))) {
    throw new Error('Renewlet exchange-rate snapshot capturedAt is invalid.');
  }
  return { month, base: 'USD', rates, sourceDate, capturedAt };
}

function parseTransaction(raw: unknown, index: number): RenewletTransaction {
  const value = record(raw, `Renewlet transaction ${index}`);
  const type = value.type;
  if (type !== 'expense' && type !== 'income' && type !== 'refund') {
    throw new Error(`Renewlet transaction ${index}.type is invalid.`);
  }
  const amount = stringValue(value.amount, `Renewlet transaction ${index}.amount`);
  moneyUnits(amount);
  const currency = stringValue(
    value.currency,
    `Renewlet transaction ${index}.currency`
  ).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error(`Renewlet transaction ${index}.currency is invalid.`);
  }
  const occurredAt = stringValue(value.occurredAt, `Renewlet transaction ${index}.occurredAt`);
  if (Number.isNaN(Date.parse(occurredAt))) {
    throw new Error(`Renewlet transaction ${index}.occurredAt is invalid.`);
  }
  const merchant = value.merchant;
  if (merchant !== null && typeof merchant !== 'string') {
    throw new Error(`Renewlet transaction ${index}.merchant must be a string or null.`);
  }
  return {
    id: stringValue(value.id, `Renewlet transaction ${index}.id`),
    type,
    amount,
    currency,
    occurredAt,
    category: stringValue(value.category, `Renewlet transaction ${index}.category`),
    merchant,
  };
}

function convertedMoneyUnits(
  amount: string,
  fromCurrency: string,
  toCurrency: string,
  basis: RenewletReportBasis | null
): bigint {
  const amountValue = Number(amount);
  if (!Number.isFinite(amountValue) || amountValue < 0) {
    throw new Error(`Invalid Renewlet money amount ${amount}.`);
  }
  if (fromCurrency === toCurrency) return moneyUnits(amount);
  if (!basis) {
    throw new Error(
      `Renewlet locked exchange-rate snapshot is required for ${fromCurrency}/${toCurrency}.`
    );
  }
  const fromRate = basis.rates[fromCurrency];
  const toRate = basis.rates[toCurrency];
  if (!fromRate || !toRate) {
    throw new Error(
      `Renewlet locked exchange-rate snapshot does not cover ${fromCurrency}/${toCurrency}.`
    );
  }
  const convertedUnits = Math.round((amountValue / fromRate) * toRate * Number(MONEY_SCALE));
  if (!Number.isSafeInteger(convertedUnits)) {
    throw new Error(`Converted Renewlet money amount ${amount} exceeds the safe range.`);
  }
  return BigInt(convertedUnits);
}

function recentRow(transaction: RenewletTransaction, timeZone: string): RecentExpenseRow {
  return {
    visible: true,
    date: formatMonthDay(transaction.occurredAt, timeZone),
    merchant: transaction.merchant?.trim() || transaction.category,
    category: transaction.category,
    amount: `-${currencySymbol(transaction.currency)}${formatUnits(moneyUnits(transaction.amount))}`,
  };
}

function hiddenRecentRow(): RecentExpenseRow {
  return { visible: false, date: '', merchant: '', category: '', amount: '' };
}

function categoryRow(name: string, amount: bigint, totalExpense: bigint): MonthlyCategoryRow {
  return {
    visible: true,
    name,
    amount: formatUnits(amount),
    share_text: formatShare(amount, totalExpense),
  };
}

function hiddenCategoryRow(): MonthlyCategoryRow {
  return { visible: false, name: '', amount: '', share_text: '' };
}

function moneyUnits(value: string): bigint {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if (!match) throw new Error(`Invalid Renewlet money amount ${value}.`);
  const fraction = (match[2] ?? '').padEnd(6, '0');
  return BigInt(match[1]!) * MONEY_SCALE + BigInt(fraction || '0');
}

function formatUnits(units: bigint): string {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const cents = (absolute + CENT_SCALE / 2n) / CENT_SCALE;
  const whole = cents / 100n;
  const fraction = cents % 100n;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${fraction.toString().padStart(2, '0')}`;
}

function formatSignedUnits(units: bigint): string {
  return `${units >= 0n ? '+' : '-'}${formatUnits(units < 0n ? -units : units)}`;
}

function formatShare(value: bigint, total: bigint): string {
  if (total <= 0n) return '0%';
  const tenths = (value * 1000n + total / 2n) / total;
  const whole = tenths / 10n;
  const fraction = tenths % 10n;
  return fraction === 0n ? `${whole}%` : `${whole}.${fraction}%`;
}

function currencySymbol(currency: string): string {
  switch (currency) {
    case 'CNY':
    case 'JPY':
      return '¥';
    case 'USD':
      return '$';
    case 'EUR':
      return '€';
    case 'GBP':
      return '£';
    case 'HKD':
      return 'HK$';
    default:
      return `${currency} `;
  }
}

function formatMonthDay(instant: string, timeZone: string): string {
  const parts = datePartsInTimeZone(new Date(instant), timeZone);
  return `${String(parts.month).padStart(2, '0')}/${String(parts.day).padStart(2, '0')}`;
}

function formatUpdatedAt(date: Date, timeZone: string): string {
  const parts = dateTimePartsInTimeZone(date, timeZone);
  return `${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

function localMidnightToInstant(year: number, month: number, day: number, timeZone: string): Date {
  let timestamp = Date.UTC(year, month - 1, day);
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const parts = dateTimePartsInTimeZone(new Date(timestamp), timeZone);
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const target = Date.UTC(year, month - 1, day);
    const delta = represented - target;
    if (delta === 0) break;
    timestamp -= delta;
  }
  return new Date(timestamp);
}

function datePartsInTimeZone(
  date: Date,
  timeZone: string
): { year: number; month: number; day: number } {
  const parts = dateTimePartsInTimeZone(date, timeZone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function dateTimePartsInTimeZone(
  date: Date,
  timeZone: string
): { year: number; month: number; day: number; hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = new Map(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: requiredNumberPart(parts, 'year'),
    month: requiredNumberPart(parts, 'month'),
    day: requiredNumberPart(parts, 'day'),
    hour: requiredNumberPart(parts, 'hour'),
    minute: requiredNumberPart(parts, 'minute'),
  };
}

function requiredNumberPart(parts: Map<string, string>, name: string): number {
  const value = Number(parts.get(name));
  if (!Number.isInteger(value)) throw new Error(`Intl.DateTimeFormat did not return ${name}.`);
  return value;
}

function isPrivateOrContainerHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === 'host.docker.internal' ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.lan') ||
    !normalized.includes('.')
  ) {
    return true;
  }
  const match = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((value) => value < 0 || value > 255)) return false;
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a string.`);
  return value.trim();
}
