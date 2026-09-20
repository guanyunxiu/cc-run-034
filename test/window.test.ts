// 窗口函数：ROW_NUMBER / RANK / SUM() OVER
import { describe, it, expect } from './harness';
import { newEngine, column, rows, query, expectSqlError } from './helpers';

async function seed() {
  const e = await newEngine();
  await e.execute('CREATE TABLE t (id INTEGER, dept TEXT, salary INTEGER)');
  await e.execute(`INSERT INTO t VALUES (1,'a',10),(2,'a',30),(3,'a',30),(4,'b',20)`);
  return e;
}

describe('窗口函数', () => {
  it('131. ROW_NUMBER() 按分区编号，同薪行号不同', async () => {
    const e = await seed();
    const r = await rows(e,
      `SELECT id, ROW_NUMBER() OVER (PARTITION BY dept ORDER BY salary DESC) AS rn FROM t`);
    // a 组：2 和 3 薪水相同，行号分别为 1 和 2；1 的行号是 3；b 组 4 的行号是 1
    const byId = new Map(r.map((x) => [x.id, x.rn]));
    expect(byId.get(2)).toBe(1);
    expect(byId.get(3)).toBe(2);
    expect(byId.get(1)).toBe(3);
    expect(byId.get(4)).toBe(1);
  });

  it('132. RANK() 并列同名次，下一名次跳过', async () => {
    const e = await seed();
    const r = await rows(e,
      `SELECT id, RANK() OVER (PARTITION BY dept ORDER BY salary DESC) AS rn FROM t`);
    const byId = new Map(r.map((x) => [x.id, x.rn]));
    expect(byId.get(2)).toBe(1);
    expect(byId.get(3)).toBe(1);
    expect(byId.get(1)).toBe(3);
    expect(byId.get(4)).toBe(1);
  });

  it('133. SUM() OVER (PARTITION BY ...) 整分区求和', async () => {
    const e = await seed();
    const r = await rows(e,
      `SELECT dept, id, SUM(salary) OVER (PARTITION BY dept) AS total FROM t`);
    expect(r).toEqual([
      { dept: 'a', id: 1, total: 70 },
      { dept: 'a', id: 2, total: 70 },
      { dept: 'a', id: 3, total: 70 },
      { dept: 'b', id: 4, total: 20 },
    ]);
  });

  it('134. 结果列没有隐藏列', async () => {
    const e = await seed();
    const res = await query(e,
      `SELECT id, ROW_NUMBER() OVER (PARTITION BY dept ORDER BY salary DESC) AS rn FROM t`);
    expect(res.columns.map((c) => c.name)).toEqual(['id', 'rn']);
    for (const row of res.rows) {
      expect(Object.keys(row).sort()).toEqual(['id', 'rn']);
    }
  });

  it('135. 窗口函数写在 WHERE 里报错', async () => {
    const e = await seed();
    await expectSqlError(e,
      `SELECT id FROM t WHERE ROW_NUMBER() OVER (PARTITION BY dept) = 1`,
      /window function.*not allowed in WHERE/);
  });

  it('136. 窗口函数写在 GROUP BY / HAVING 里同样报错', async () => {
    const e = await seed();
    await expectSqlError(e,
      `SELECT dept FROM t GROUP BY ROW_NUMBER() OVER ()`,
      /not allowed in GROUP BY/);
    await expectSqlError(e,
      `SELECT dept, SUM(salary) FROM t GROUP BY dept HAVING RANK() OVER () = 1`,
      /not allowed in HAVING/);
  });

  it('137. ROW_NUMBER() 缺少 OVER 报错', async () => {
    const e = await seed();
    await expectSqlError(e, `SELECT ROW_NUMBER() FROM t`, /requires an OVER clause/);
  });

  it('138. 无 PARTITION BY：全表编号，可配合外层 ORDER BY', async () => {
    const e = await seed();
    const r = await rows(e,
      `SELECT id, ROW_NUMBER() OVER (ORDER BY id DESC) AS rn FROM t ORDER BY id`);
    expect(r).toEqual([
      { id: 1, rn: 4 },
      { id: 2, rn: 3 },
      { id: 3, rn: 2 },
      { id: 4, rn: 1 },
    ]);
  });

  it('139. 同一句多个窗口函数，相同窗口复用结果一致', async () => {
    const e = await seed();
    const r = await rows(e,
      `SELECT id,
              ROW_NUMBER() OVER (ORDER BY salary DESC) AS a,
              ROW_NUMBER() OVER (ORDER BY salary DESC) AS b,
              RANK() OVER (ORDER BY salary DESC) AS rk
       FROM t ORDER BY id`);
    expect(r).toEqual([
      { id: 1, a: 4, b: 4, rk: 4 },
      { id: 2, a: 1, b: 1, rk: 1 },
      { id: 3, a: 2, b: 2, rk: 1 },
      { id: 4, a: 3, b: 3, rk: 3 },
    ]);
  });

  it('140. SUM() OVER 带 ORDER BY 是累计求和（含并列行）', async () => {
    const e = await seed();
    const r = await rows(e,
      `SELECT id, SUM(salary) OVER (ORDER BY salary) AS running FROM t ORDER BY id`);
    // salary 排序：10(1) -> 30(2),30(3) 并列 -> 20(4) 按 salary 排在 10 与 30 之间
    const byId = new Map(r.map((x) => [x.id, x.running]));
    expect(byId.get(1)).toBe(10);           // 10
    expect(byId.get(4)).toBe(30);           // 10+20
    expect(byId.get(2)).toBe(90);           // 10+20+30+30（并列同行一起进框架）
    expect(byId.get(3)).toBe(90);
  });

  it('141. COUNT(*) OVER () 统计分区行数', async () => {
    const e = await seed();
    const r = await rows(e,
      `SELECT id, COUNT(*) OVER (PARTITION BY dept) AS n FROM t ORDER BY id`);
    expect(r.map((x) => x.n)).toEqual([3, 3, 3, 1]);
  });

  it('142. 窗口函数可用在 FROM 子查询中，外层可再过滤', async () => {
    const e = await seed();
    const r = await rows(e,
      `SELECT id, rn FROM (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY dept ORDER BY salary DESC) AS rn FROM t
       ) s WHERE rn = 1 ORDER BY id`);
    expect(r).toEqual([
      { id: 2, rn: 1 },
      { id: 4, rn: 1 },
    ]);
  });

  it('143. 窗口函数与 GROUP BY 共存互不影响', async () => {
    const e = await seed();
    const r = await rows(e,
      `SELECT dept, SUM(salary) AS total,
              RANK() OVER (ORDER BY SUM(salary) DESC) AS rk
       FROM t GROUP BY dept ORDER BY dept`);
    expect(r).toEqual([
      { dept: 'a', total: 70, rk: 1 },
      { dept: 'b', total: 20, rk: 2 },
    ]);
  });

  it('144. 窗口函数 ORDER BY 输出别名', async () => {
    const e = await seed();
    const r = await rows(e,
      `SELECT id, ROW_NUMBER() OVER (ORDER BY salary) AS rn FROM t ORDER BY rn`);
    expect(r.map((x) => x.id)).toEqual([1, 4, 2, 3]);
  });

  it('145. 分区键为 NULL 时聚为同一分区', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE n (g TEXT, v INTEGER)');
    await e.execute(`INSERT INTO n VALUES (NULL,1),(NULL,2),('x',5)`);
    const r = await rows(e,
      `SELECT v, SUM(v) OVER (PARTITION BY g) AS s FROM n ORDER BY v`);
    expect(r).toEqual([
      { v: 1, s: 3 },
      { v: 2, s: 3 },
      { v: 5, s: 5 },
    ]);
  });

  it('146. 窗口函数嵌套报错', async () => {
    const e = await seed();
    await expectSqlError(e,
      `SELECT ROW_NUMBER() OVER (ORDER BY RANK() OVER ()) FROM t`,
      /cannot be nested/);
  });

  it('147. 窗口子句中可引用聚合（先分组再开窗）', async () => {
    const e = await seed();
    // 全局聚合只有一行（SUM(salary)=90），窗口 SUM 作用在这一行上
    const r = await rows(e, `SELECT SUM(SUM(salary)) OVER () AS s FROM t`);
    expect(r).toEqual([{ s: 90 }]);
  });

  it('148. EXPLAIN 展示窗口算子', async () => {
    const e = await seed();
    const res = await query(e,
      `EXPLAIN SELECT id, ROW_NUMBER() OVER (PARTITION BY dept) AS rn FROM t`);
    expect(res.plan?.physical).toContain('WindowAgg');
  });
});
