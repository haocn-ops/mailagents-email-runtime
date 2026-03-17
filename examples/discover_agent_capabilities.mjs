const baseUrl = process.env.MAILAGENTS_BASE_URL ?? "https://mailagents-dev.izhenghaocn.workers.dev";
const token = process.env.MAILAGENTS_TOKEN;

if (!token) {
  console.error("MAILAGENTS_TOKEN is required");
  process.exit(1);
}

async function postJson(path, body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

const compatibility = await getJson("/v2/meta/compatibility");
const tools = await postJson(
  "/mcp",
  {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  },
  {
    authorization: `Bearer ${token}`,
  }
);

console.log(JSON.stringify({
  compatibilityVersion: compatibility.contract.version,
  stableErrorCodes: compatibility.guarantees.stableErrorCodes,
  visibleTools: tools.result.tools.map((tool) => ({
    name: tool.name,
    riskLevel: tool.annotations?.riskLevel,
    humanReviewRequired: tool.annotations?.humanReviewRequired,
    sendAdditionalScopes: tool.annotations?.sendAdditionalScopes ?? [],
  })),
}, null, 2));
