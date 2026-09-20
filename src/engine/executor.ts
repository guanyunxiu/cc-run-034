// ============================================================
// 火山模型（Volcano）执行器
// 每个算子实现 open()/next()/close()，逐行拉取。
// ============================================================

import type { DBValue, Row } from '../sql/types';
import { truthy } from './eval-expr';
import type { EvalRow, ExecFrame } from './eval-expr';
import type {
  LogicalPlan, LogicalJoin, BoundExpr, IndexUse, AggregateSpec, WindowFuncSpec,
} from './logical-plan';
import type { ExprPool } from './binder';
import type { Database, Transaction } from './database';
import { compareValues, sqlValueKey } from './table-store';
import type { SubqueryRuntime } from './subquery-runtime';

export interface ExecStats {
  rowsScanned: number;
  rowsOutput: number;
  indexLookups: number;
  hashJoinsBuilt: number;
  hashJoinRows: number;
}

export interface ExecContext {
  db: Database;
  txn: Transaction;
  pool: ExprPool;
  stats: ExecStats;
  subqueries: SubqueryRuntime;
}

export abstract class Operator {
  abstract open(frame: ExecFrame): void;
  abstract next(frame: ExecFrame): EvalRow | null;
  close(_frame: ExecFrame): void { /* 默认无资源 */ }

  /** 拉取全部行（便捷方法） */
  all(frame: ExecFrame): EvalRow[] {
    this.open(frame);
    const out: EvalRow[] = [];
    let row: EvalRow | null;
    while ((row = this.next(frame))) out.push(row);
    this.close(frame);
    return out;
  }
}

// ------------------------------------------------------------
// Scan（支持索引访问）
// ------------------------------------------------------------
export class ScanOp extends Operator {
  private iterator: IterableIterator<{ pk: string; data: Row }> | null = null;
  private indexUse: IndexUse | null = null;
  private buffered: { pk: string; data: Row }[] | null = null;
  private bufPos = 0;
  private alias: string;
  private hiddenRowId: boolean;

  constructor(
    private db: Database,
    private tableName: string,
    alias: string,
    private columnIds: { id: string; origin: string }[],
    indexUse: IndexUse | undefined,
    private ctx: ExecContext,
  ) {
    super();
    this.alias = alias;
    this.indexUse = indexUse ?? null;
    const store = this.db.getTable(tableName);
    this.hiddenRowId = !store.def.primaryKey;
  }

  open(_frame: ExecFrame): void {
    const store = this.db.getTable(this.tableName);
    if (this.indexUse) {
      this.ctx.stats.indexLookups++;
      const col = this.indexUse.column;
      if (this.indexUse.access === 'EQ') {
        this.buffered = store.lookup(col, this.indexUse.eqValue ?? null).map((r) => ({ pk: r.pk, data: r.data }));
      } else if (this.indexUse.access === 'RANGE' && this.indexUse.range) {
        const r = this.indexUse.range;
        this.buffered = store.rangeLookup(col, r.low, r.high, r.lowInclusive, r.highInclusive)
          .map((x) => ({ pk: x.pk, data: x.data }));
      }
      this.bufPos = 0;
    } else {
      this.iterator = store.all()[Symbol.iterator]();
    }
  }

  next(_frame: ExecFrame): EvalRow | null {
    let raw: { pk: string; data: Row } | undefined;
    if (this.indexUse && this.buffered) {
      raw = this.buffered[this.bufPos++];
    } else if (this.iterator) {
      raw = this.iterator.next().value as { pk: string; data: Row } | undefined;
    }
    if (!raw) return null;
    this.ctx.stats.rowsScanned++;

    const out: EvalRow = {};
    for (const c of this.columnIds) {
      out[c.id] = raw.data[c.origin] ?? null;
    }
    // 物理 pk 以特殊键传递（UPDATE/DELETE 用）
    out[`${this.alias.toLowerCase()}.__pk__`] = raw.pk;
    if (this.hiddenRowId) {
      out[`${this.alias.toLowerCase()}.__rowid__`] = raw.data.__rowid__ ?? null;
    }
    return out;
  }
}

// ------------------------------------------------------------
// Dummy（无 FROM 的单行）
// ------------------------------------------------------------
export class DummyOp extends Operator {
  private emitted = false;
  open(): void { this.emitted = false; }
  next(): EvalRow | null {
    if (this.emitted) return null;
    this.emitted = true;
    return {};
  }
}

// ------------------------------------------------------------
// Filter
// ------------------------------------------------------------
export class FilterOp extends Operator {
  constructor(
    private child: Operator,
    private predicate: BoundExpr,
  ) { super(); }

  open(frame: ExecFrame): void { this.child.open(frame); }
  next(frame: ExecFrame): EvalRow | null {
    for (;;) {
      const row = this.child.next(frame);
      if (!row) return null;
      const v = this.predicate.eval(row, frame);
      if (truthy(v) === true) return row;
    }
  }
  close(frame: ExecFrame): void { this.child.close(frame); }
}

// ------------------------------------------------------------
// Project
// ------------------------------------------------------------
export class ProjectOp extends Operator {
  constructor(
    private child: Operator,
    private items: { expr: BoundExpr; label: string }[],
  ) { super(); }

  open(frame: ExecFrame): void { this.child.open(frame); }
  next(frame: ExecFrame): EvalRow | null {
    const row = this.child.next(frame);
    if (!row) return null;
    const out: EvalRow = {};
    for (const it of this.items) {
      out[it.label] = it.expr.eval(row, frame);
    }
    this.ctxPush(row, out);
    return out;
  }
  close(frame: ExecFrame): void { this.child.close(frame); }

  private ctxPush(_src: EvalRow, _out: EvalRow): void { /* 占位 */ }
}

// ------------------------------------------------------------
// Nested Loop Join（INNER / LEFT）
// ------------------------------------------------------------
export class NestedLoopJoinOp extends Operator {
  private leftRow: EvalRow | null = null;
  private rightOpened = false;
  private leftMatched = false;
  private nullPadEmitted = false;

  constructor(
    private join: LogicalJoin,
    private left: Operator,
    private right: Operator,
    private condition: BoundExpr | null,
    private rightColumnIds: string[],
  ) { super(); }

  open(frame: ExecFrame): void {
    this.left.open(frame);
    this.leftRow = this.left.next(frame);
    this.rightOpened = false;
  }

  private openRight(frame: ExecFrame): void {
    this.right.open(frame);
    this.rightOpened = true;
  }
  private closeRight(frame: ExecFrame): void {
    if (this.rightOpened) {
      this.right.close(frame);
      this.rightOpened = false;
    }
  }

  next(frame: ExecFrame): EvalRow | null {
    while (this.leftRow) {
      if (!this.rightOpened) {
        this.openRight(frame);
        this.leftMatched = false;
        this.nullPadEmitted = false;
      }
      let rightRow: EvalRow | null;
      while ((rightRow = this.right.next(frame))) {
        const combined = { ...this.leftRow, ...rightRow };
        if (!this.condition || truthy(this.condition.eval(combined, frame)) === true) {
          this.leftMatched = true;
          return combined;
        }
      }
      this.closeRight(frame);
      if (!this.leftMatched && this.join.joinType === 'LEFT' && !this.nullPadEmitted) {
        this.nullPadEmitted = true;
        const out: EvalRow = { ...this.leftRow };
        for (const id of this.rightColumnIds) out[id] = null;
        this.leftRow = this.left.next(frame);
        return out;
      }
      this.leftRow = this.left.next(frame);
    }
    return null;
  }

  close(frame: ExecFrame): void {
    this.closeRight(frame);
    this.left.close(frame);
  }
}

// ------------------------------------------------------------
// Hash Join
// 构建阶段以右表为内侧（build 侧），探测左表
// ------------------------------------------------------------
type CompiledKeyExpr = (row: EvalRow, frame: ExecFrame) => DBValue;

export class HashJoinOp extends Operator {
  private hashTable = new Map<string, EvalRow[]>();
  private leftRow: EvalRow | null = null;
  private matches: EvalRow[] = [];
  private matchPos = 0;
  private leftMatched = false; // 当前左行是否已产出至少一条匹配
  private nullPadEmitted = false;

  constructor(
    private join: LogicalJoin,
    private left: Operator,
    private right: Operator,
    private leftKeys: CompiledKeyExpr[],
    private rightKeys: CompiledKeyExpr[],
    private others: BoundExpr[],
    private rightColumnIds: string[],
    private ctx: ExecContext,
  ) { super(); }

  open(frame: ExecFrame): void {
    this.hashTable.clear();
    this.right.open(frame);
    let r: EvalRow | null;
    while ((r = this.right.next(frame))) {
      // 任一连接键为 null => 永不匹配等值连接，不放入哈希表
      if (!this.keyHasNull(this.rightKeys, r, frame)) {
        const key = this.hashKey(this.rightKeys, r, frame);
        const bucket = this.hashTable.get(key) ?? [];
        bucket.push(r);
        this.hashTable.set(key, bucket);
      }
    }
    this.right.close(frame);
    this.ctx.stats.hashJoinsBuilt++;
    this.ctx.stats.hashJoinRows += this.hashTable.size;

    this.left.open(frame);
    this.loadNextLeft(frame);
  }

  private keyHasNull(fns: CompiledKeyExpr[], row: EvalRow, frame: ExecFrame): boolean {
    return fns.some((f) => f(row, frame) === null);
  }

  private loadNextLeft(frame: ExecFrame): void {
    this.leftRow = this.left.next(frame);
    this.matches = [];
    this.matchPos = 0;
    this.leftMatched = false;
    this.nullPadEmitted = false;
    if (this.leftRow) {
      if (!this.keyHasNull(this.leftKeys, this.leftRow, frame)) {
        const key = this.hashKey(this.leftKeys, this.leftRow, frame);
        this.matches = this.hashTable.get(key) ?? [];
      }
    }
  }

  next(frame: ExecFrame): EvalRow | null {
    while (this.leftRow) {
      // 遍历当前左行的候选右行
      while (this.matchPos < this.matches.length) {
        const rightRow = this.matches[this.matchPos++];
        const combined = { ...this.leftRow, ...rightRow };
        if (this.others.length === 0 || this.others.every((c) => truthy(c.eval(combined, frame)) === true)) {
          this.leftMatched = true;
          return combined;
        }
      }
      // LEFT JOIN：当前左行无任何匹配 => 输出一次右列全 NULL
      if (!this.leftMatched && this.join.joinType === 'LEFT' && !this.nullPadEmitted) {
        this.nullPadEmitted = true;
        return this.padRightWithNulls(this.leftRow);
      }
      this.loadNextLeft(frame);
    }
    return null;
  }

  private padRightWithNulls(leftRow: EvalRow): EvalRow {
    const out: EvalRow = { ...leftRow };
    for (const id of this.rightColumnIds) out[id] = null;
    return out;
  }

  close(frame: ExecFrame): void { this.left.close(frame); }

  private hashKey(fns: CompiledKeyExpr[], row: EvalRow, frame: ExecFrame): string {
    return fns.map((f) => valueKey(f(row, frame))).join('|');
  }
}

/** 分组/连接/DISTINCT 哈希键：与 SQL 等值规则一致，布尔按 0/1 归入数值 */
export function valueKey(v: DBValue): string {
  return sqlValueKey(v);
}

// ------------------------------------------------------------
// Aggregate
// ------------------------------------------------------------
interface AggGroupState {
  groupKey: string;
  groupValues: DBValue[];
  /** 每个聚合一个累加状态 */
  states: AggAccumulator[];
  /** DISTINCT 聚合的已见值集合（与 aggs 下标对齐） */
  distinctSets: (Set<string> | null)[];
  representativeRow: EvalRow;
}

type AggAccumulator =
  | { kind: 'COUNT'; count: number }
  | { kind: 'SUM'; sum: number; isInt: boolean; seen: boolean }
  | { kind: 'AVG'; sum: number; count: number }
  | { kind: 'MINMAX'; min: DBValue; max: DBValue; seen: boolean };

export class AggregateOp extends Operator {
  private groups: AggGroupState[] = [];
  private pos = 0;
  private groupLabels: string[];
  private aggLabels: string[];

  constructor(
    private child: Operator,
    private groupExprs: BoundExpr[],
    private aggs: AggregateSpec[],
    groupLabels: string[],
    aggLabels: string[],
    private globalAgg: boolean,
    private ctx: ExecContext,
  ) {
    super();
    this.groupLabels = groupLabels;
    this.aggLabels = aggLabels;
  }

  open(frame: ExecFrame): void {
    this.child.open(frame);
    const map = new Map<string, AggGroupState>();
    this.groups = [];

    let row: EvalRow | null;
    while ((row = this.child.next(frame))) {
      const current: EvalRow = row;
      const groupValues = this.groupExprs.map((g) => g.eval(current, frame));
      // GROUP BY 中 null 分组（null 聚在一起）
      const key = groupValues.map(valueKey).join('|');
      let state = map.get(key);
      if (!state) {
        state = {
          groupKey: key,
          groupValues,
          states: this.aggs.map((a) => newAccumulator(a)),
          distinctSets: this.aggs.map((a) => (a.distinct ? new Set<string>() : null)),
          representativeRow: current,
        };
        map.set(key, state);
        this.groups.push(state);
      }
      for (let i = 0; i < this.aggs.length; i++) {
        const spec = this.aggs[i];
        let v: DBValue = null;
        if (spec.arg !== null) v = this.ctx.pool.get(spec.arg).eval(current, frame);
        // DISTINCT：非 null 值先去重（COUNT(*) 无 distinct）
        if (spec.distinct && spec.arg !== null) {
          if (v === null) continue;
          const set = state.distinctSets[i]!;
          const k = valueKey(v);
          if (set.has(k)) continue;
          set.add(k);
        }
        accumulate(state.states[i], spec, v);
      }
    }

    // 全局聚合（无 GROUP BY）：零行也要输出一行
    if (this.globalAgg && this.groups.length === 0) {
      this.groups = [{
        groupKey: '',
        groupValues: [],
        states: this.aggs.map((a) => newAccumulator(a)),
        distinctSets: this.aggs.map((a) => (a.distinct ? new Set<string>() : null)),
        representativeRow: {},
      }];
    }
    this.pos = 0;
  }

  next(frame: ExecFrame): EvalRow | null {
    if (this.pos >= this.groups.length) return null;
    const g = this.groups[this.pos++];
    const out: EvalRow = {};
    // 有 GROUP BY 时，透传分组代表行的源列。
    // 实用的函数依赖扩展：分组键（尤其主键）函数决定同表其它列。
    // 非分组列在语义上不保证唯一，此处取每组首行的值。
    if (!this.globalAgg) {
      for (const [k, v] of Object.entries(g.representativeRow)) {
        if (!k.endsWith('.__pk__')) out[k] = v;
      }
    }
    for (let i = 0; i < this.groupExprs.length; i++) {
      const value = g.groupValues[i];
      out[this.groupLabels[i]] = value;
      for (const refId of this.groupExprs[i].columnRefs) {
        if (!refId.startsWith('outer')) out[refId] = value;
      }
    }
    for (let i = 0; i < this.aggs.length; i++) {
      out[this.aggLabels[i]] = finalize(g.states[i], this.aggs[i]);
    }
    return out;
  }

  close(frame: ExecFrame): void { this.child.close(frame); }
}

function newAccumulator(spec: AggregateSpec): AggAccumulator {
  switch (spec.kind) {
    case 'COUNT': return { kind: 'COUNT', count: 0 };
    case 'SUM': return { kind: 'SUM', sum: 0, isInt: true, seen: false };
    case 'AVG': return { kind: 'AVG', sum: 0, count: 0 };
    case 'MIN':
    case 'MAX': return { kind: 'MINMAX', min: null, max: null, seen: false };
  }
}

function accumulate(acc: AggAccumulator, spec: AggregateSpec, v: DBValue): void {
  if (spec.kind === 'COUNT') {
    // COUNT(*) 始终计数；COUNT(expr) 跳过 null（DISTINCT 已在外层去重）
    if (acc.kind === 'COUNT' && (spec.arg === null || v !== null)) acc.count++;
    return;
  }
  if (v === null) return;
  switch (acc.kind) {
    case 'SUM':
      acc.seen = true;
      acc.sum += numeric(v);
      if (typeof v !== 'number' || !Number.isInteger(v)) acc.isInt = false;
      break;
    case 'AVG':
      acc.sum += numeric(v);
      acc.count++;
      break;
    case 'MINMAX':
      acc.seen = true;
      if (acc.min === null || compareValues(v, acc.min) < 0) acc.min = v;
      if (acc.max === null || compareValues(v, acc.max) > 0) acc.max = v;
      break;
    case 'COUNT': break;
  }
}

function numeric(v: DBValue): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return Number(v);
}

function finalize(acc: AggAccumulator, spec: AggregateSpec): DBValue {
  switch (acc.kind) {
    case 'COUNT': return acc.count;
    case 'SUM':
      if (!acc.seen) return null;
      return acc.sum;
    case 'AVG':
      if (acc.count === 0) return null;
      return acc.sum / acc.count; // REAL
    case 'MINMAX':
      return spec.kind === 'MIN' ? acc.min : acc.max;
  }
}

/** DISTINCT 聚合去重：按 (聚合下标, 值) 过滤输入行 */
export class DistinctAggregateOp extends Operator {
  constructor(
    private child: Operator,
    private specs: AggregateSpec[],
  ) { super(); }

  private seen: Set<string>[] = [];
  open(frame: ExecFrame): void {
    this.seen = this.specs.map(() => new Set());
    this.child.open(frame);
  }
  next(frame: ExecFrame): EvalRow | null {
    // 该算子实际由 AggregateOp 内部感知；这里不单独使用
    return this.child.next(frame);
  }
  close(frame: ExecFrame): void { this.child.close(frame); }
}

// ------------------------------------------------------------
// Sort
// ------------------------------------------------------------
export class SortOp extends Operator {
  private rows: EvalRow[] = [];
  private pos = 0;
  constructor(
    private child: Operator,
    private keys: { expr: BoundExpr; desc: boolean; nullsFirst: boolean }[],
  ) { super(); }

  open(frame: ExecFrame): void {
    this.rows = this.child.all(frame);
    // 稳定排序：索引作为最终 tiebreak
    this.rows.sort((a, b) => {
      for (const k of this.keys) {
        const av = k.expr.eval(a, frame);
        const bv = k.expr.eval(b, frame);
        if (av === null && bv === null) continue;
        if (av === null) return k.nullsFirst ? -1 : 1;
        if (bv === null) return k.nullsFirst ? 1 : -1;
        const c = compareValues(av, bv);
        if (c !== 0) return k.desc ? -c : c;
      }
      return 0;
    });
    this.pos = 0;
  }

  next(_frame: ExecFrame): EvalRow | null {
    return this.rows[this.pos++] ?? null;
  }

  close(frame: ExecFrame): void { this.child.close(frame); }
}

// ------------------------------------------------------------
// Limit / Offset
// ------------------------------------------------------------
export class LimitOp extends Operator {
  private skipped = 0;
  private emitted = 0;
  constructor(
    private child: Operator,
    private limit: number,
    private offset: number,
  ) { super(); }

  open(frame: ExecFrame): void {
    this.child.open(frame);
    this.skipped = 0;
    this.emitted = 0;
  }
  next(frame: ExecFrame): EvalRow | null {
    while (this.skipped < this.offset) {
      if (!this.child.next(frame)) return null;
      this.skipped++;
    }
    if (this.emitted >= this.limit) return null;
    const row = this.child.next(frame);
    if (row) this.emitted++;
    return row;
  }
  close(frame: ExecFrame): void { this.child.close(frame); }
}

// ------------------------------------------------------------
// Window：分区 + 分区内排序后计算窗口函数，结果写入行内键
// 输出行序：分区按首现顺序，分区内按窗口 ORDER BY（稳定）
// ------------------------------------------------------------

/** 窗口表达式在行内的物化键（拉取行时立即求值，避免聚合帧等行上下文失效） */
interface MaterializedWindow {
  spec: WindowFuncSpec;
  argKey: string | null;
  partKeys: string[];
  orderKeys: string[];
}

export class WindowOp extends Operator {
  private rows: EvalRow[] = [];
  private pos = 0;
  private mat: MaterializedWindow[] = [];

  constructor(
    private child: Operator,
    private windows: WindowFuncSpec[],
    private pool: { get(id: number): BoundExpr },
  ) { super(); }

  open(frame: ExecFrame): void {
    this.mat = this.windows.map((spec, w) => ({
      spec,
      argKey: spec.arg !== null ? `__wx${w}a` : null,
      partKeys: spec.partitionBy.map((_, i) => `__wx${w}p${i}`),
      orderKeys: spec.orderBy.map((_, i) => `__wx${w}o${i}`),
    }));

    // 逐行拉取并立即物化窗口表达式：此时 frame.agg（聚合值）等
    // 行级上下文仍对应当前行；全部拉完后这些上下文即失效。
    this.child.open(frame);
    const input: EvalRow[] = [];
    let row: EvalRow | null;
    while ((row = this.child.next(frame))) {
      for (const mw of this.mat) {
        const spec = mw.spec;
        if (mw.argKey !== null && spec.arg !== null) {
          row[mw.argKey] = this.pool.get(spec.arg).eval(row, frame);
        }
        for (let i = 0; i < mw.partKeys.length; i++) {
          row[mw.partKeys[i]] = this.pool.get(spec.partitionBy[i]).eval(row, frame);
        }
        for (let i = 0; i < mw.orderKeys.length; i++) {
          row[mw.orderKeys[i]] = this.pool.get(spec.orderBy[i].expr).eval(row, frame);
        }
      }
      input.push(row);
    }
    this.child.close(frame);

    let order: number[] | null = null;
    for (let w = 0; w < this.mat.length; w++) {
      const seq = this.computeWindow(this.mat[w], input);
      // 输出顺序由第一个窗口函数的分区/排序决定
      if (w === 0) order = seq;
    }
    this.rows = order ? order.map((i) => input[i]) : input;
    this.pos = 0;
  }

  next(_frame: ExecFrame): EvalRow | null {
    return this.rows[this.pos++] ?? null;
  }

  /** 计算一个窗口函数并把结果写入各行的 spec.label，返回行下标的输出顺序 */
  private computeWindow(mw: MaterializedWindow, input: EvalRow[]): number[] {
    // 分区：按分区键首现顺序分组
    const partitions = new Map<string, number[]>();
    for (let i = 0; i < input.length; i++) {
      const key = mw.partKeys.map((k) => valueKey(input[i][k] ?? null)).join('|');
      const arr = partitions.get(key);
      if (arr) arr.push(i);
      else partitions.set(key, [i]);
    }

    const order: number[] = [];
    for (const indices of partitions.values()) {
      // 分区内按 ORDER BY 排序（原始下标兜底，保证稳定）
      const sorted = [...indices].sort((a, b) =>
        this.compareRows(mw, input[a], input[b]) || a - b);
      this.evaluatePartition(mw, sorted, input);
      order.push(...sorted);
    }
    return order;
  }

  private compareRows(mw: MaterializedWindow, ra: EvalRow, rb: EvalRow): number {
    const keys = mw.spec.orderBy;
    for (let i = 0; i < keys.length; i++) {
      const av = ra[mw.orderKeys[i]] ?? null;
      const bv = rb[mw.orderKeys[i]] ?? null;
      if (av === null && bv === null) continue;
      if (av === null) return keys[i].nullsFirst ? -1 : 1;
      if (bv === null) return keys[i].nullsFirst ? 1 : -1;
      const c = compareValues(av, bv);
      if (c !== 0) return keys[i].desc ? -c : c;
    }
    return 0;
  }

  /** ORDER BY 各键全部相等（NULL 与 NULL 视为相等）即为同一 peer 组 */
  private samePeer(mw: MaterializedWindow, ra: EvalRow, rb: EvalRow): boolean {
    for (const k of mw.orderKeys) {
      if (compareValues(ra[k] ?? null, rb[k] ?? null) !== 0) return false;
    }
    return true;
  }

  private evaluatePartition(mw: MaterializedWindow, sorted: number[], input: EvalRow[]): void {
    const spec = mw.spec;
    if (spec.name === 'ROW_NUMBER') {
      sorted.forEach((idx, i) => { input[idx][spec.label] = i + 1; });
      return;
    }
    if (spec.name === 'RANK') {
      let rank = 0;
      for (let i = 0; i < sorted.length; i++) {
        if (i === 0 || !this.samePeer(mw, input[sorted[i - 1]], input[sorted[i]])) {
          rank = i + 1;
        }
        input[sorted[i]][spec.label] = rank;
      }
      return;
    }
    // 聚合窗口（SUM/COUNT/AVG/MIN/MAX）
    const aggSpec: AggregateSpec = {
      kind: spec.name as AggregateSpec['kind'],
      distinct: false,
      arg: spec.arg,
      label: spec.label,
      type: 'ANY',
    };
    const valueOf = (idx: number): DBValue =>
      mw.argKey !== null ? (input[idx][mw.argKey] ?? null) : null;

    if (spec.orderBy.length === 0) {
      // 无 ORDER BY：窗口帧为整个分区
      const acc = newAccumulator(aggSpec);
      for (const idx of sorted) accumulate(acc, aggSpec, valueOf(idx));
      const val = finalize(acc, aggSpec);
      for (const idx of sorted) input[idx][spec.label] = val;
      return;
    }
    // 有 ORDER BY：默认帧 RANGE UNBOUNDED PRECEDING .. CURRENT ROW（累计到当前 peer 组末）
    const acc = newAccumulator(aggSpec);
    let i = 0;
    while (i < sorted.length) {
      let j = i + 1;
      while (j < sorted.length && this.samePeer(mw, input[sorted[j - 1]], input[sorted[j]])) j++;
      for (let k = i; k < j; k++) accumulate(acc, aggSpec, valueOf(sorted[k]));
      const val = finalize(acc, aggSpec);
      for (let k = i; k < j; k++) input[sorted[k]][spec.label] = val;
      i = j;
    }
  }
}

// ------------------------------------------------------------
// 集合运算：UNION / UNION ALL / EXCEPT
// 行相等性按 SQL 集合语义：NULL 与 NULL 视为同一行
// ------------------------------------------------------------
export class SetOpOp extends Operator {
  private rows: EvalRow[] = [];
  private pos = 0;

  constructor(
    private op: 'UNION' | 'UNION ALL' | 'EXCEPT',
    private left: Operator,
    private right: Operator,
    private leftLabels: string[],
    private rightLabels: string[],
  ) { super(); }

  open(frame: ExecFrame): void {
    const leftRows = this.left.all(frame).map((r) => this.remap(r, this.leftLabels));
    const rightRows = this.right.all(frame).map((r) => this.remap(r, this.rightLabels));
    switch (this.op) {
      case 'UNION ALL':
        // 不去重：先左后右
        this.rows = [...leftRows, ...rightRows];
        break;
      case 'UNION': {
        // 去重：保留首次出现（左侧优先）
        const seen = new Set<string>();
        const out: EvalRow[] = [];
        for (const r of [...leftRows, ...rightRows]) {
          const k = this.rowKey(r);
          if (!seen.has(k)) {
            seen.add(k);
            out.push(r);
          }
        }
        this.rows = out;
        break;
      }
      case 'EXCEPT': {
        // EXCEPT DISTINCT：左侧中不在右侧出现的行，结果去重
        const rightKeys = new Set(rightRows.map((r) => this.rowKey(r)));
        const seen = new Set<string>();
        const out: EvalRow[] = [];
        for (const r of leftRows) {
          const k = this.rowKey(r);
          if (rightKeys.has(k) || seen.has(k)) continue;
          seen.add(k);
          out.push(r);
        }
        this.rows = out;
        break;
      }
    }
    this.pos = 0;
  }

  next(_frame: ExecFrame): EvalRow | null {
    return this.rows[this.pos++] ?? null;
  }

  close(frame: ExecFrame): void {
    this.left.close(frame);
    this.right.close(frame);
  }

  /** 把一侧输出行按位置映射到统一的输出键（leftLabels） */
  private remap(row: EvalRow, labels: string[]): EvalRow {
    const out: EvalRow = {};
    for (let i = 0; i < this.leftLabels.length; i++) {
      out[this.leftLabels[i]] = row[labels[i]] ?? null;
    }
    return out;
  }

  private rowKey(row: EvalRow): string {
    return this.leftLabels.map((l) => valueKey(row[l] ?? null)).join('|');
  }
}

// ------------------------------------------------------------
// Distinct
// ------------------------------------------------------------
export class DistinctOp extends Operator {
  private seen = new Set<string>();
  constructor(private child: Operator) { super(); }
  open(frame: ExecFrame): void {
    this.seen.clear();
    this.child.open(frame);
  }
  next(frame: ExecFrame): EvalRow | null {
    for (;;) {
      const row = this.child.next(frame);
      if (!row) return null;
      const key = Object.keys(row)
        .filter((k) => !k.endsWith('.__pk__'))
        .sort()
        .map((k) => `${k}=${valueKey(row[k])}`).join(';');
      if (!this.seen.has(key)) {
        this.seen.add(key);
        return row;
      }
    }
  }
  close(frame: ExecFrame): void { this.child.close(frame); }
}

// ------------------------------------------------------------
// 子查询数据源（FROM 子查询）
// ------------------------------------------------------------
export class SubquerySourceOp extends Operator {
  constructor(
    private child: Operator,
    private alias: string,
    private mapping: { innerLabel: string; outerId: string }[],
  ) { super(); }

  open(frame: ExecFrame): void { this.child.open(frame); }
  next(frame: ExecFrame): EvalRow | null {
    const row = this.child.next(frame);
    if (!row) return null;
    const out: EvalRow = {};
    for (const m of this.mapping) {
      out[m.outerId] = row[m.innerLabel] ?? null;
    }
    return out;
  }
  close(frame: ExecFrame): void { this.child.close(frame); }
}
