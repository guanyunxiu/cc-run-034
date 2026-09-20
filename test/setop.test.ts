// 集合运算：UNION / UNION ALL / EXCEPT
import { describe, it, expect } from './harness';
import { newEngine, column, rows, expectSqlError } from './helpers';

async function seed() {
  const e = await newEngine();
  await e.execute('CREATE TABLE a (id INTEGER)');
  await e.execute('INSERT INTO a VALUES (1),(2),(2)');
  await e.execute('CREATE TABLE b (id INTEGER)');
  await e.execute('INSERT INTO b VALUES (2),(3)');
  return e;
}

describe('集合运算', () => {
  it('144. UNION 去重，左侧优先', async () => {
    const e = await seed();
    expect(await column(e, 'SELECT id FROM a UNION SELECT id FROM b')).toEqual([1, 2, 3]);
  });

  it('145. UNION ALL 保留重复，顺序先左后右', async () => {
    const e = await seed();
    expect(await column(e, 'SELECT id FROM a UNION ALL SELECT id FROM b'))
      .toEqual([1, 2, 2, 2, 3]);
  });

  it('146. EXCEPT 只保留左侧独有的行', async () => {
    const e = await seed();
    expect(await column(e, 'SELECT id FROM a EXCEPT SELECT id FROM b')).toEqual([1]);
  });

  it('147. 两边列数不一样报错并指出是哪一句', async () => {
    const e = await seed();
    const err = await expectSqlError(e,
      'SELECT id, id FROM a UNION SELECT id FROM b', /same number of columns/);
    expect(err.message).toContain('left SELECT has 2');
    expect(err.message).toContain('right SELECT has 1');
    await expectSqlError(e,
      'SELECT id FROM a EXCEPT SELECT id, id FROM b',
      /each EXCEPT query must have the same number of columns/);
  });

  it('148. UNION 包一层子查询后 ORDER BY 倒序', async () => {
    const e = await seed();
    expect(await column(e,
      'SELECT * FROM (SELECT id FROM a UNION SELECT id FROM b) u ORDER BY id DESC'))
      .toEqual([3, 2, 1]);
  });

  it('149. UNION 尾部 ORDER BY 作用于整个结果', async () => {
    const e = await seed();
    expect(await column(e, 'SELECT id FROM a UNION SELECT id FROM b ORDER BY id DESC'))
      .toEqual([3, 2, 1]);
    expect(await column(e, 'SELECT id FROM a UNION ALL SELECT id FROM b ORDER BY id LIMIT 3'))
      .toEqual([1, 2, 2]);
  });

  it('150. NULL 与 NULL 在 EXCEPT 里算同一行', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE an (id INTEGER)');
    await e.execute('INSERT INTO an VALUES (1),(NULL)');
    await e.execute('CREATE TABLE bn (id INTEGER)');
    await e.execute('INSERT INTO bn VALUES (NULL)');
    // NULL 对得上：an 的 NULL 被排除，不多留一行
    expect(await column(e, 'SELECT id FROM an EXCEPT SELECT id FROM bn')).toEqual([1]);
    // UNION 中两个 NULL 也只留一行
    expect(await column(e, 'SELECT id FROM an UNION SELECT id FROM bn')).toEqual([1, null]);
  });

  it('151. UNION DISTINCT 显式写法与 UNION 同义', async () => {
    const e = await seed();
    expect(await column(e, 'SELECT id FROM a UNION DISTINCT SELECT id FROM b'))
      .toEqual([1, 2, 3]);
  });

  it('152. 多段集合运算左结合', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE x (v INTEGER)');
    await e.execute('INSERT INTO x VALUES (1),(2),(3)');
    // (1,2,3 UNION 2,3,4) EXCEPT 3 => 1,2,4
    expect(await column(e,
      'SELECT v FROM x UNION SELECT v + 1 v2 FROM x EXCEPT SELECT 3'))
      .toEqual([1, 2, 4]);
  });

  it('153. 集合运算结果可用于 FROM 子查询与 IN 子查询', async () => {
    const e = await seed();
    // FROM 子查询 + JOIN 不受影响
    const r = await rows(e,
      `SELECT u.id, b.id AS bid FROM (SELECT id FROM a UNION SELECT id FROM b) u
       LEFT JOIN b ON b.id = u.id ORDER BY u.id`);
    expect(r).toEqual([
      { id: 1, bid: null },
      { id: 2, bid: 2 },
      { id: 3, bid: 3 },
    ]);
    // IN 子查询
    expect(await column(e,
      'SELECT id FROM b WHERE id IN (SELECT id FROM a UNION ALL SELECT id FROM b) ORDER BY id'))
      .toEqual([2, 3]);
  });

  it('154. 集合运算两侧可带 WHERE/GROUP BY，JOIN 不受影响', async () => {
    const e = await seed();
    expect(await column(e,
      `SELECT id FROM a WHERE id > 1 UNION SELECT id FROM b WHERE id < 3 ORDER BY id`))
      .toEqual([2]);
    const r = await rows(e,
      `SELECT id, cnt FROM (
         SELECT id, COUNT(*) cnt FROM a GROUP BY id
         UNION
         SELECT id, COUNT(*) cnt FROM b GROUP BY id
       ) u ORDER BY id, cnt`);
    // (2, cnt=2) 与 (2, cnt=1) 是不同行，UNION 都保留
    expect(r).toEqual([
      { id: 1, cnt: 1 },
      { id: 2, cnt: 1 },
      { id: 2, cnt: 2 },
      { id: 3, cnt: 1 },
    ]);
    // 普通 JOIN 行为不变
    expect(await column(e, 'SELECT a.id FROM a JOIN b ON a.id = b.id')).toEqual([2, 2]);
  });

  it('155. INSERT ... SELECT 支持集合运算', async () => {
    const e = await seed();
    await e.execute('CREATE TABLE c (id INTEGER)');
    await e.execute('INSERT INTO c SELECT id FROM a UNION SELECT id FROM b');
    expect(await column(e, 'SELECT id FROM c')).toEqual([1, 2, 3]);
  });
});
