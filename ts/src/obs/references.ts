let level = "Info";
export const withMinimumLogLevel = async <A>(
  next: string,
  work: () => Promise<A>,
) => {
  const before = level;
  level = next;
  const value = await work();
  level = before;
  return value;
};
export const fiberLocalMinimumLogLevelDemo = async () => {
  const before = level;
  const inside = await withMinimumLogLevel("Debug", async () => level);
  return { before, inside, after: level };
};
