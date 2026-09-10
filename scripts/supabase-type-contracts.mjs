/** Preserve a known nullable RPC argument and reject generator shape drift. */
function nullableArgument(generated, functionName, argumentName, argumentType) {
  const marker = `      ${functionName}: {`;
  const start = generated.indexOf(marker);
  if (start === -1) {
    if (generated.includes(`${functionName}:`)) {
      throw new Error(`${functionName} generator format changed.`);
    }
    return generated;
  }
  const end = generated.indexOf('\n        Returns:', start);
  if (end === -1) throw new Error(`Cannot find ${functionName} argument boundary.`);
  const args = generated.slice(start, end);
  const lines = args.split('\n');
  const field = `          ${argumentName}: ${argumentType}`;
  const index = lines.findIndex((line) => line === field || line === `${field} | null`);
  if (index === -1) throw new Error(`Cannot find nullable argument ${functionName}.${argumentName}.`);
  lines[index] = `${field} | null`;
  return generated.slice(0, start) + lines.join('\n') + generated.slice(end);
}

/**
 * PostgreSQL function arguments have no NOT NULL catalog metadata. Preserve
 * known nullable RPC contracts that the Supabase generator otherwise narrows.
 * Only these explicitly reviewed fields are widened, never other arguments.
 */
export function applyEngineeringRpcNullability(generated) {
  let result = nullableArgument(generated, 'api_resolve_engineering_request', 'p_depth_mm', 'number');
  result = nullableArgument(result, 'api_control_worker_session', 'p_boot_id', 'string');
  return result;
}
