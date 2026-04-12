import { getMailboxByAddress } from "../repositories/agents";
import type { Env } from "../types";

export interface LocalMailboxRecipient {
  address: string;
  mailboxId: string;
  tenantId: string;
}

export interface RoutedOutboundRecipients {
  toInternal: LocalMailboxRecipient[];
  ccInternal: LocalMailboxRecipient[];
  bccInternal: LocalMailboxRecipient[];
  toExternal: string[];
  ccExternal: string[];
  bccExternal: string[];
  internalRecipientCount: number;
  externalRecipientCount: number;
  externalToRecipientCount: number;
  recipientDomains: string[];
  internalDomains: string[];
  externalDomains: string[];
}

export function normalizeRecipientAddress(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeRecipientList(values: string[]): string[] {
  return values.map(normalizeRecipientAddress).filter(Boolean);
}

function recipientDomain(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at === -1 || at === address.length - 1) {
    return null;
  }

  return address.slice(at + 1);
}

function uniqueDomains(addresses: string[]): string[] {
  return Array.from(new Set(addresses.map(recipientDomain).filter((item): item is string => Boolean(item))));
}

export async function routeOutboundRecipients(env: Env, input: {
  to: string[];
  cc?: string[];
  bcc?: string[];
}): Promise<RoutedOutboundRecipients> {
  const to = normalizeRecipientList(input.to);
  const cc = normalizeRecipientList(input.cc ?? []);
  const bcc = normalizeRecipientList(input.bcc ?? []);
  const uniqueAddresses = Array.from(new Set([...to, ...cc, ...bcc]));
  const mailboxEntries = await Promise.all(
    uniqueAddresses.map(async (address) => {
      const mailbox = await getMailboxByAddress(env, address);
      return [
        address,
        mailbox && mailbox.status === "active"
          ? {
              address,
              mailboxId: mailbox.id,
              tenantId: mailbox.tenant_id,
            }
          : null,
      ] as const;
    })
  );
  const localMailboxes = new Map<string, LocalMailboxRecipient>(
    mailboxEntries
      .filter((entry): entry is readonly [string, LocalMailboxRecipient] => entry[1] !== null)
      .map(([address, mailbox]) => [address, mailbox])
  );

  const splitList = (addresses: string[]): {
    internal: LocalMailboxRecipient[];
    external: string[];
  } => {
    const internal: LocalMailboxRecipient[] = [];
    const external: string[] = [];

    for (const address of addresses) {
      const mailbox = localMailboxes.get(address);
      if (mailbox) {
        internal.push(mailbox);
      } else {
        external.push(address);
      }
    }

    return { internal, external };
  };

  const toSplit = splitList(to);
  const ccSplit = splitList(cc);
  const bccSplit = splitList(bcc);
  const internalAddresses = [
    ...toSplit.internal,
    ...ccSplit.internal,
    ...bccSplit.internal,
  ].map((recipient) => recipient.address);
  const externalAddresses = [
    ...toSplit.external,
    ...ccSplit.external,
    ...bccSplit.external,
  ];

  return {
    toInternal: toSplit.internal,
    ccInternal: ccSplit.internal,
    bccInternal: bccSplit.internal,
    toExternal: toSplit.external,
    ccExternal: ccSplit.external,
    bccExternal: bccSplit.external,
    internalRecipientCount: internalAddresses.length,
    externalRecipientCount: externalAddresses.length,
    externalToRecipientCount: toSplit.external.length,
    recipientDomains: uniqueDomains([...internalAddresses, ...externalAddresses]),
    internalDomains: uniqueDomains(internalAddresses),
    externalDomains: uniqueDomains(externalAddresses),
  };
}

export function getOutboundRecipientRoutingValidationError(input: {
  externalRecipientCount: number;
  externalToRecipientCount: number;
}): string | null {
  if (input.externalRecipientCount > 0 && input.externalToRecipientCount === 0) {
    return "External delivery requires at least one external To recipient after internal routing";
  }

  return null;
}
