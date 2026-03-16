export async function firstRow<T>(statement: D1PreparedStatement): Promise<T | null> {
  const result = await statement.run<T>();
  const row = result.results?.[0];
  return (row as T | undefined) ?? null;
}

export async function allRows<T>(statement: D1PreparedStatement): Promise<T[]> {
  const result = await statement.run<T>();
  return (result.results ?? []) as T[];
}

export function requireRow<T>(row: T | null, message: string): T {
  if (!row) {
    throw new Error(message);
  }

  return row;
}

export async function execute(statement: D1PreparedStatement): Promise<Awaited<ReturnType<D1PreparedStatement["run"]>>> {
  return await statement.run();
}
