// Shared JSON POST helper for LLM providers (fetch with timeout and readable errors).
export async function postJson(url, { headers, body, timeoutMs }) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e?.name === 'TimeoutError') throw new Error(`The language model did not answer within ${Math.round(timeoutMs / 1000)}s`);
    throw new Error(`Cannot reach the language model API: ${e?.cause?.code || e.message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Language model API returned HTTP ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Language model API returned a non-JSON response');
  }
}
