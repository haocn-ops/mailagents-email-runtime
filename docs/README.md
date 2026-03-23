# Documentation Guide

This page is the fastest way to find the right document in `docs/` without
guessing from filenames.

## Start Here

If you only want the minimum reading order:

1. [README.md](../README.md)
2. [docs/llms-agent-guide.md](./llms-agent-guide.md)
3. [docs/local-dev.md](./local-dev.md) for local setup
4. [docs/deployment.md](./deployment.md) for remote environments

## Recommended By Persona

If you are a:

- product integrator
  - [docs/llms-agent-guide.md](./llms-agent-guide.md)
  - [docs/agent-sdk-examples.md](./agent-sdk-examples.md)
  - [docs/openapi.yaml](./openapi.yaml)
- agent developer
  - [docs/mcp-local.md](./mcp-local.md)
  - [docs/agent-sdk-examples.md](./agent-sdk-examples.md)
  - [docs/runtime-metadata.md](./runtime-metadata.md)
- advanced operator
  - [docs/deployment.md](./deployment.md)
  - [docs/testing.md](./testing.md)
  - [docs/x402-real-payment-checklist.md](./x402-real-payment-checklist.md)
  - [docs/production-rollout-checklist.md](./production-rollout-checklist.md)

## External Agent Integrators

Use this set when you are building an agent, SDK, or orchestration layer
against the runtime:

- [docs/llms-agent-guide.md](./llms-agent-guide.md) — best single starting point
- [docs/ai-onboarding.md](./ai-onboarding.md) — runtime model, safety rules, and call sequence
- [docs/ai-auth.md](./ai-auth.md) — bearer tokens, scopes, signup tokens, and rotation
- [docs/ai-mail-workflows.md](./ai-mail-workflows.md) — mailbox read, send, reply, replay, and draft flows
- [docs/limits-and-access.md](./limits-and-access.md) — current usage limits and how external delivery gets enabled
- [docs/agent-sdk-examples.md](./agent-sdk-examples.md) — copyable HTTP and MCP examples
- [docs/mcp-local.md](./mcp-local.md) — local MCP usage and tool examples

## Local Development

Use this set when you are running the project locally or changing runtime code:

- [docs/local-dev.md](./local-dev.md) — default local setup and API walkthrough
- [docs/testing.md](./testing.md) — local and remote smoke flows
- [docs/x402-real-payment-checklist.md](./x402-real-payment-checklist.md) — first real Base Sepolia + USDC payment run
- [docs/dev-bootstrap.md](./dev-bootstrap.md) — first real `dev` environment bootstrap
- [docs/deployment.md](./deployment.md) — Cloudflare and SES environment wiring
- [docs/mvp-spec.md](./mvp-spec.md) — product and architecture baseline

## Runtime Discovery And Contracts

Use these docs when you need stable machine-readable integration points:

- [docs/runtime-metadata.md](./runtime-metadata.md) — `/v2/meta/runtime`
- [docs/runtime-compatibility.md](./runtime-compatibility.md) — `/v2/meta/compatibility`
- [docs/admin-mcp.md](./admin-mcp.md) — `/admin/mcp` operator MCP surface
- [docs/admin-workflow-packs.md](./admin-workflow-packs.md) — operator workflow planning above admin MCP tools
- [docs/admin-workflow-packs.json](./admin-workflow-packs.json) — machine-readable admin workflow pack data
- [docs/runtime-compatibility.schema.json](./runtime-compatibility.schema.json) — compatibility schema
- [docs/openapi.yaml](./openapi.yaml) — HTTP API surface
- [docs/agent-capabilities.json](./agent-capabilities.json) — pinned capability snapshot
- [docs/mcp-tools.schema.json](./mcp-tools.schema.json) — MCP tool metadata schema

## AI Agent Behavior And Safety

Use these pages when you need policy, safety, or operator-facing guidance:

- [docs/ai-decision-rules.md](./ai-decision-rules.md) — safe branching and stop conditions
- [docs/ai-agents.md](./ai-agents.md) — agent provisioning, mailbox binding, and tasks
- [docs/ai-debug.md](./ai-debug.md) — debug and admin endpoints
- [docs/agent-workflow-packs.md](./agent-workflow-packs.md) — reusable workflow patterns
- [docs/agent-workflow-packs.json](./agent-workflow-packs.json) — machine-readable workflow pack data
- [docs/admin-workflow-packs.md](./admin-workflow-packs.md) — reusable admin/operator workflow patterns
- [docs/admin-workflow-packs.json](./admin-workflow-packs.json) — machine-readable admin workflow pack data

## Production And Operations

Use these docs when you are touching live infrastructure or production mailboxes:

- [docs/deployment.md](./deployment.md) — shared deployment checklist
- [docs/production-rollout-checklist.md](./production-rollout-checklist.md) — production rollout record and runbook
- [docs/production-operator-bootstrap.md](./production-operator-bootstrap.md) — first safe production write path
- [docs/testing.md](./testing.md) — current smoke coverage and verification boundaries
- [docs/x402-real-payment-checklist.md](./x402-real-payment-checklist.md) — first real testnet payment runbook
- [docs/archive/README.md](./archive/README.md) — dated rollout and verification records

## SDK And Client Work

Use these docs when you are evolving the TypeScript helper or publishable client:

- [docs/agent-client-helper.md](./agent-client-helper.md) — in-repo helper overview
- [packages/mailagents-agent-client/README.md](../packages/mailagents-agent-client/README.md) — package usage
- [docs/agent-client-release.md](./agent-client-release.md) — release checklist
- [docs/agent-client-versioning.md](./agent-client-versioning.md) — versioning policy
- [docs/agent-client-release-notes-0.1.0.md](./agent-client-release-notes-0.1.0.md) — draft release notes

## Design And Roadmap

Use these when you want background on why the runtime is shaped this way:

- [docs/agent-registry.md](./agent-registry.md) — versioned agent registry model
- [docs/agent-feedback-roadmap.md](./agent-feedback-roadmap.md) — future product direction
- [docs/mvp-spec.md](./mvp-spec.md) — original MVP framing

## Quick Picks

If you are trying to:

- send and reply with a mailbox token
  - [docs/ai-mail-workflows.md](./ai-mail-workflows.md)
- learn the MCP surface quickly
  - [docs/mcp-local.md](./mcp-local.md)
- validate local setup
  - [docs/local-dev.md](./local-dev.md)
  - [docs/testing.md](./testing.md)
- prepare a real x402 payment test
  - [docs/x402-real-payment-checklist.md](./x402-real-payment-checklist.md)
  - [docs/x402-did-architecture-plan.md](./x402-did-architecture-plan.md)
- understand current limits or unlock external delivery
  - [docs/limits-and-access.md](./limits-and-access.md)
  - [docs/openapi.yaml](./openapi.yaml)
- bootstrap or repair production
  - [docs/production-rollout-checklist.md](./production-rollout-checklist.md)
  - [docs/production-operator-bootstrap.md](./production-operator-bootstrap.md)
- work on the published client path
  - [docs/agent-client-release.md](./agent-client-release.md)
  - [docs/agent-client-versioning.md](./agent-client-versioning.md)
