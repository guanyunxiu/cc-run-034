// 集合运算：UNION / UNION ALL / EXCEPT
import { describe, it, expect } from './harness';
import { newEngine, column, rows, query, expectSqlError } from './helpers';

async function seed() {
  const e = await newEngine();
  await e.execute('CREATE TABLE a (id INTEGER)');
  await e.execute('INSERT INTO a VALUES (1),(2),(2)');
  await e.execute('CREATE TABLE b (id INTEGER)');
  await e.execute('INSERT INTO b VALUES (2),(3)');
  return e;
}

describe('集合运算', () => {
  it('149. UNION 去重合并', async () => {
    const e = await seed();
    expect(await column(e, 'SELECT id FROM a UNION SELECT id FROM b')).toEqual([1, 2, 3]);
  });

  it('150. UNION ALL 保留重复，先左后右', async () => {
    const e = await seed();
    expect(await column(e, 'SELECT id FROM a UNION ALL SELECT id FROM b'))
      .toEqual([1, 2, 2, 2, 3]);
  });

  it('151. EXCEPT 差集', async () => {
    const e = await seed();
    expect(await column(e, 'SELECT id FROM a EXCEPT SELECT id FROM b')).toEqual([1]);
  });

  it('152. 两边列数不一样报错并指出是哪一句', async () => {
    const e = await seed();
    await expectSqlError(e,
      'SELECT id FROM a UNION SELECT id, id FROM b',
      /SELECT #1 has 1 but SELECT #2 has 2/);
    await expectSqlError(e,
      'SELECT id, id FROM a EXCEPT SELECT id FROM b',
      /SELECT #1 has 2 but SELECT #2 has 1/);
  });

  it('153. UNION 包一层后 ORDER BY 倒序', async () => {
    const e = await seed();
    expect(await column(e,
      'SELECT * FROM (SELECT id FROM a UNION SELECT id FROM b) u ORDER BY id DESC'))
      .toEqual([3, 2, 1]);
  });

  it('154. 复合查询末尾直接 ORDER BY / LIMIT', async () => {
    const e = await seed();
    expect(await column(e, 'SELECT id FROM a UNION SELECT id FROM b ORDER BY id DESC'))
      .toEqual([3, 2, 1]);
    expect(await column(e, 'SELECT id FROM a UNION ALL SELECT id FROM b ORDER BY id LIMIT 3'))
      .toEqual([1, 2, 2]);
    // ORDER BY 位置序号
    expect(await column(e, 'SELECT id FROM a UNION SELECT id FROM b ORDER BY 1 DESC'))
      .toEqual([3, 2, 1]);
  });

  it('155. NULL 与 NULL 在 EXCEPT 里算同一行', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE ta (id INTEGER)');
    await e.execute('INSERT INTO ta VALUES (NULL),(1),(1)');
    await e.execute('CREATE TABLE tb (id INTEGER)');
    await e.execute('INSERT INTO tb VALUES (NULL)');
    expect(await column(e, 'SELECT id FROM ta EXCEPT SELECT id FROM tb')).toEqual([1]);
    // UNION 中 NULL 也只留一行
    expect(await column(e, 'SELECT id FROM tb UNION SELECT id FROM tb')).toEqual([null]);
  });

  it('156. 列按位置对齐，结果列名取第一段 SELECT', async () => {
    const e = await seed();
    const res = await query(e,
      'SELECT id AS x, id + 10 AS y FROM a UNION ALL SELECT id, id FROM b ORDER BY x, y');
    expect(res.columns.map((c) => c.name)).toEqual(['x', 'y']);
    expect(res.rows).toEqual([
      { x: 1, y: 11 },
      { x: 2, y: 2 },
      { x: 2, y: 12 },
      { x: 2, y: 12 },
      { x: 3, y: 3 },
    ]);
  });

  it('157. 链式集合运算左结合', async () => {
    const e = await seed();
    // (a UNION b) EXCEPT {3} => {1,2}
    await e.execute('CREATE TABLE c (id INTEGER)');
    await e.execute('INSERT INTO c VALUES (3)');
    expect(await column(e, 'SELECT id FROM a UNION SELECT id FROM b EXCEPT SELECT id FROM c'))
      .toEqual([1, 2]);
  });

  it('158. UNION 可用在 IN / EXISTS / 标量子查询中', async () => {
    const e = await seed();
    expect(await column(e,
      'SELECT id FROM a WHERE id IN (SELECT id FROM b UNION SELECT id FROM a ORDER BY 1)'))
      .toEqual([1, 2, 2]);
    expect(await column(e,
      'SELECT id FROM a WHERE EXISTS (SELECT id FROM b EXCEPT SELECT id FROM a)'))
      .toEqual([1, 2, 2]); // b EXCEPT a = {3} 非空
    expect(await column(e,
      'SELECT (SELECT COUNT(*) FROM (SELECT id FROM a UNION SELECT id FROM b) u) FROM a LIMIT 1'))
      .toEqual([3]);
  });

  it('159. UNION 两侧可带 WHERE/GROUP BY/聚合', async () => {
    const e = await seed();
    const r = await rows(e,
      `SELECT id FROM a WHERE id > 1
       UNION
       SELECT SUM(id) FROM b
       ORDER BY id`);
    expect(r.map((x) => x.id)).toEqual([2, 5]);
  });

  it('160. UNION DISTINCT 与 UNION 等价', async () => {
    const e = await seed();
    expect(await column(e, 'SELECT id FROM a UNION DISTINCT SELECT id FROM b'))
      .toEqual([1, 2, 3]);
  });

  it('161. INSERT ... SELECT 支持集合运算', async () => {
    const e = await seed();
    await e.execute('CREATE TABLE t (id INTEGER)');
    await e.execute('INSERT INTO t SELECT id FROM a UNION SELECT id FROM b');
    expect(await column(e, 'SELECT id FROM t')).toEqual([1, 2, 3]);
  });

  it('162. 非末尾分支带 ORDER BY 报错', async () => {
    const e = await seed();
    await expectSqlError(e,
      'SELECT id FROM a ORDER BY id UNION SELECT id FROM b',
      /ORDER BY\/LIMIT must appear after the last SELECT/);
  });

  it('163. 复合查询 ORDER BY 只能引用输出列', async () => {
    const e = await seed();
    await expectSqlError(e,
      'SELECT id FROM a UNION SELECT id FROM b ORDER BY nope',
      /not an output column/);
  });

  it('164. UNION 结果与 JOIN 组合', async () => {
    const e = await seed();
    await e.execute('CREATE TABLE d (id INTEGER, tag TEXT)');
    await e.execute(`INSERT INTO d VALUES (1,'x'),(3,'z')`);
    const r = await rows(e,
      `SELECT u.id, d.tag FROM (SELECT id FROM a UNION SELECT id FROM b) u
       JOIN d ON d.id = u.id ORDER BY u.id`);
    expect(r).toEqual([
      { id: 1, tag: 'x' },
      { id: 3, tag: 'z' },
    ]);
  });

  it('165. EXCEPT 左表去重（DISTINCT 语义）', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE p (id INTEGER)');
    await e.execute('INSERT INTO p VALUES (1),(1),(2)');
    await e.execute('CREATE TABLE q (id INTEGER)');
    await e.execute('INSERT INTO q VALUES (2)');
    expect(await column(e, 'SELECT id FROM p EXCEPT SELECT id FROM q')).toEqual([1]);
  });

  it('166. EXPLAIN 展示集合运算算子', async () => {
    const e = await seed();
    const res = await query(e, 'EXPLAIN SELECT id FROM a UNION SELECT id FROM b');
    expect(res.plan?.physical).toContain('Union');
  });
});
