/**
 * PostgreSQL function arguments have no NOT NULL catalog metadata. Preserve
 * known nullable RPC contracts that the Supabase generator otherwise narrows.
 * Fail on generator shape drift instead of silently emitting the wrong type.
 */
export function applyEngineeringRpcNullability(generated) {
  const marker = '      api_resolve_engineering_request: {';
  const start = generated.indexOf(marker);
  if (start === -1) {
    if (generated.includes('api_resolve_engineering_request:')) {
      throw new Error('Engineering request RPC generator format changed.');
    }
    return generated;
  }
  const end = generated.indexOf('\n        Returns:', start);
  if (end === -1) throw new Error('Cannot find engineering request RPC argument boundary.');
  const args = generated.slice(start, end);
  const parameter = /^(\s+p_depth_mm: )number(?: \| null)?$/m;
  if (!parameter.test(args)) throw new Error('Cannot find the numeric engineering request depth argument.');
  return generated.slice(0, start) + args.replace(parameter, '$1number | null') + generated.slice(end);
}
