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
  it('131. ROW_NUMBER 分区内排序编号（同薪不同行号）', async () => {
    const e = await seed();
    const r = await rows(e,
      `SELECT id, ROW_NUMBER() OVER (PARTITION BY dept ORDER BY salary DESC) AS rn FROM t`);
    expect(r).toEqual([
      { id: 2, rn: 1 },
      { id: 3, rn: 2 },
      { id: 1, rn: 3 },
      { id: 4, rn: 1 },
    ]);
  });

  it('132. RANK 同名次并列、跳过后续名次', async () => {
    const e = await seed();
    const r = await rows(e,
      `SELECT id, RANK() OVER (PARTITION BY dept ORDER BY salary DESC) AS rk FROM t`);
    expect(r).toEqual([
      { id: 2, rk: 1 },
      { id: 3, rk: 1 },
      { id: 1, rk: 3 },
      { id: 4, rk: 1 },
    ]);
  });

  it('133. SUM() OVER (PARTITION BY ...) 每行都是分区合计', async () => {
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

  it('134. 窗口函数写在 WHERE 里报错', async () => {
    const e = await seed();
    await expectSqlError(e,
      `SELECT id FROM t WHERE ROW_NUMBER() OVER (PARTITION BY dept) = 1`,
      /window functions are not allowed in WHERE/);
    await expectSqlError(e,
      `SELECT id FROM t WHERE RANK() OVER (ORDER BY salary) > 2`,
      /window/);
  });

  it('135. 结果列只有 SELECT 项，无隐藏列', async () => {
    const e = await seed();
    const r = await query(e,
      `SELECT id, ROW_NUMBER() OVER (PARTITION BY dept ORDER BY salary DESC) AS rn FROM t`);
    expect(r.columns.map((c) => c.name)).toEqual(['id', 'rn']);
    for (const row of r.rows) {
      expect(Object.keys(row).sort()).toEqual(['id', 'rn']);
    }
  });

  it('136. ROW_NUMBER 无 PARTITION 时全表一个分区', async () => {
    const e = await seed();
    const r = await rows(e,
      `SELECT id, ROW_NUMBER() OVER (ORDER BY salary DESC) AS rn FROM t`);
    // salary DESC：30(id2),30(id3),20(id4),10(id1)
    expect(r.map((x) => [x.id, x.rn])).toEqual([[2, 1], [3, 2], [4, 3], [1, 4]]);
  });

  it('137. 窗口函数与 GROUP BY 共存：窗口作用于聚合结果', async () => {
    const e = await seed();
    const r = await rows(e,
      `SELECT dept, SUM(salary) AS s,
              ROW_NUMBER() OVER (ORDER BY SUM(salary) DESC) AS rn
       FROM t GROUP BY dept ORDER BY dept`);
    expect(r).toEqual([
      { dept: 'a', s: 70, rn: 1 },
      { dept: 'b', s: 20, rn: 2 },
    ]);
    // 普通 GROUP BY 不受影响
    const g = await rows(e, `SELECT dept, COUNT(*) n FROM t GROUP BY dept ORDER BY dept`);
    expect(g).toEqual([{ dept: 'a', n: 3 }, { dept: 'b', n: 1 }]);
  });

  it('138. SUM() OVER 带 ORDER BY 时累计到当前名次组', async () => {
    const e = await seed();
    const r = await rows(e,
      `SELECT id, SUM(salary) OVER (ORDER BY salary) AS running FROM t`);
    // salary 升序：10 -> 10；30,30 同组 -> 70；再 20 -> ... 按 salary: 10,20,30,30
    expect(r).toEqual([
      { id: 1, running: 10 },
      { id: 4, running: 30 },
      { id: 2, running: 90 },
      { id: 3, running: 90 },
    ]);
  });

  it('139. 窗口函数在 GROUP BY / HAVING 中报错', async () => {
    const e = await seed();
    await expectSqlError(e,
      `SELECT dept FROM t GROUP BY ROW_NUMBER() OVER (ORDER BY salary)`,
      /window functions are not allowed in GROUP BY/);
    await expectSqlError(e,
      `SELECT dept, SUM(salary) s FROM t GROUP BY dept HAVING RANK() OVER (ORDER BY s) > 1`,
      /window functions are not allowed in HAVING/);
  });

  it('140. ROW_NUMBER 缺少 OVER 报错；窗口函数不能嵌套', async () => {
    const e = await seed();
    await expectSqlError(e, `SELECT ROW_NUMBER() FROM t`, /requires an OVER clause/);
    await expectSqlError(e,
      `SELECT ROW_NUMBER() OVER (ORDER BY RANK() OVER (ORDER BY salary)) FROM t`,
      /cannot be nested/);
  });

  it('141. COUNT(*) OVER 与空 OVER 子句', async () => {
    const e = await seed();
    const r = await rows(e, `SELECT id, COUNT(*) OVER () AS n FROM t ORDER BY id`);
    expect(r.map((x) => x.n)).toEqual([4, 4, 4, 4]);
  });

  it('142. 窗口函数可用别名排序（ORDER BY 输出别名）', async () => {
    const e = await seed();
    const r = await rows(e,
      `SELECT dept, id, ROW_NUMBER() OVER (PARTITION BY dept ORDER BY salary DESC) AS rn
       FROM t ORDER BY dept DESC, rn`);
    expect(r.map((x) => [x.dept, x.id, x.rn])).toEqual([
      ['b', 4, 1],
      ['a', 2, 1],
      ['a', 3, 2],
      ['a', 1, 3],
    ]);
  });

  it('143. 普通 SELECT 与聚合不受窗口功能影响', async () => {
    const e = await seed();
    expect(await column(e, `SELECT COUNT(*) FROM t`)).toEqual([4]);
    expect(await column(e, `SELECT SUM(salary) FROM t WHERE dept = 'a'`)).toEqual([70]);
    const r = await rows(e, `SELECT id, salary FROM t WHERE salary >= 30 ORDER BY id`);
    expect(r).toEqual([{ id: 2, salary: 30 }, { id: 3, salary: 30 }]);
  });
});
