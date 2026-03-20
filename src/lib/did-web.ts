import type { DidBindingRecord } from "../types";

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function buildOrigin(baseUrl: string): URL {
  return new URL(baseUrl);
}

export function buildHostedDidWeb(baseUrl: string, tenantId: string): {
  did: string;
  documentUrl: string;
} {
  const origin = buildOrigin(baseUrl);
  const host = origin.host;
  const did = `did:web:${host}:did:tenants:${tenantId}`;
  const documentUrl = `${trimTrailingSlash(origin.origin)}/did/tenants/${tenantId}/did.json`;
  return { did, documentUrl };
}

export function defaultHostedDidServices(baseUrl: string, did: string, tenantId: string): Array<Record<string, unknown>> {
  const origin = buildOrigin(baseUrl).origin;
  return [
    {
      id: `${did}#api`,
      type: "MailagentsApiService",
      serviceEndpoint: `${origin}/v1`,
      tenantId,
    },
    {
      id: `${did}#mcp`,
      type: "MailagentsMcpService",
      serviceEndpoint: `${origin}/mcp`,
      tenantId,
    },
    {
      id: `${did}#payment`,
      type: "MailagentsPaymentService",
      serviceEndpoint: `${origin}/v1/billing/topup`,
      tenantId,
    },
  ];
}

export function buildDidWebDocument(baseUrl: string, binding: DidBindingRecord): Record<string, unknown> {
  const origin = buildOrigin(baseUrl).origin;
  const service = binding.service.length
    ? binding.service
    : defaultHostedDidServices(origin, binding.did, binding.tenantId);

  const document: Record<string, unknown> = {
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: binding.did,
    service,
  };

  if (binding.verificationMethodId) {
    document.assertionMethod = [binding.verificationMethodId];
  }

  return document;
}
