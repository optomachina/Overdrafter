// Word-level diff (LCS). Pure and browser-safe: the UI imports this file too.
export function tokenize(text) {
  return String(text).split(/(\s+)/).filter((s) => s.length > 0);
}

export function wordDiff(a, b) {
  const x = tokenize(a);
  const y = tokenize(b);
  const n = x.length;
  const m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  const push = (type, value) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.value += value;
    else out.push({ type, value });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      push("same", x[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push("del", x[i++]);
    } else {
      push("ins", y[j++]);
    }
  }
  while (i < n) push("del", x[i++]);
  while (j < m) push("ins", y[j++]);
  return out;
}
