# Headless agentic workflow reference (.NET)

A working template for the pattern **"an agent does the work unattended, a human makes the call in Teams,
the agent finishes the job."** Copy it for each new workflow; the hard parts are solved once here:

- Microsoft Agent Framework as the orchestrator, calling **your custom MCP servers** as tools
- A workflow that **pauses for a human, persists itself, and resumes later in any process**
- **Microsoft Teams** as the decision surface (proactive Adaptive Cards, Approve/Reject buttons)
- **Entra ID everywhere**: managed identity for the agent, app roles on MCP servers, no API keys
- A sample **Entra-secured MCP server** so you can see both sides of the handshake
- Tests that prove the pause/resume cycle without any Azure resources

## Is Microsoft Agent Framework the right orchestrator for our MCP servers?

**Yes.** Three products carry the word "Agent" and it is worth being precise:

| Product | Role in this reference | Status |
| --- | --- | --- |
| **Microsoft Agent Framework** (`Microsoft.Agents.AI.*`) | The orchestrator. Successor to Semantic Kernel and AutoGen. Runs agents, calls tools, owns the workflow graph, checkpoints, human-in-the-loop ports. Uses the official MCP C# SDK, so any MCP server (stdio or Streamable HTTP) is a tool source. | 1.0 GA April 2026; this repo pins 1.20.0 |
| **Microsoft 365 Agents SDK** (`Microsoft.Agents.Hosting.*`, `Builder`, `Core`) | The Teams channel. Successor to Bot Framework. Validates inbound Teams traffic, sends proactive messages, routes Adaptive Card actions. It does **no** AI orchestration itself and explicitly expects you to plug in Agent Framework (or anything else). | 1.8.x stable |
| **Microsoft Agent 365 SDK** | Optional governance layer (Entra Agent ID, observability, tool governance) on top of whatever you build. Not required here. | Preview |

Agent Framework earns the orchestrator role for a .NET shop because it is first-class C#, sits on
`Microsoft.Extensions.AI` abstractions (swap models without touching workflow code), has a typed graph
workflow model with checkpointing and `RequestPort` for human decisions, and treats MCP as a native tool
source. Alternatives and when to pick them instead:

- **Copilot Studio**: low-code, for makers; not for code-owned headless pipelines.
- **Foundry Agent Service (hosted agents)**: when you want Microsoft to host the agent runtime; Agent Framework
  targets it with the same `AIAgent` abstraction, so this code ports.
- **Durable Task extension for Agent Framework**: same workflow graph, but Azure Functions / Durable Task
  Scheduler runs it with automatic checkpointing and generated HTTP endpoints for the human step. Move to it when
  you need many concurrent long-running runs across instances. The executors in this repo carry over unchanged.

## What the samples do

Two workflows are registered in the host and share every piece of plumbing:

- **LeaseReview** (Land team, upstream oil and gas): a draft lease is reviewed before signature. The agent captures
  key terms, compares provisions with the company lease form, and identifies curative title work; a landman signs
  off in Teams; the review is recorded and curative tasks are opened. See
  [docs/workflows/lease-review.md](docs/workflows/lease-review.md).
- **HumanDecision** (purchasing, the minimal template): a purchase order lands on payment hold in the ERP.

The minimal template, step by step:

```
 trigger (HTTP / timer / queue)
   -> Assess          analyst agent + MCP read tools  -> structured Assessment
   -> HumanDecision   RequestPort: run halts, checkpoint saved, Adaptive Card sent to Teams
   -> ApplyDecision   operator agent + MCP write tool (approved only) -> WorkflowResult
   -> result card posted back to the same Teams conversation
```

Nothing is held in memory while the human decides. The Approve click can arrive hours later on a different
host instance; the run is rehydrated from its checkpoint and continues.

## Layout

```
src/AgentWorkflow.Core      Workflow graphs, executors, agents, MCP tool loading, checkpoint-backed runner
src/AgentWorkflow.Core/Land Lease review workflow (models, agents, executors, graph)
src/AgentWorkflow.Host      ASP.NET Core host: Teams endpoint (Agents SDK) + workflow runtime + triggers
src/SampleMcpServer         Custom MCP server secured with Entra ID (JWT validation, PRM, app roles)
tests/                      xunit: pause/resume cycle, card contract, bearer token handler
docs/architecture.md        How the pieces fit, durability model, scaling, upgrade paths
docs/authentication.md      Every identity to provision and every setting it feeds
docs/azure-admin-request.md Hand this to your Azure/Entra admin: exact steps, roles needed, values to return
infra/provision.sh          Script an admin can review and run for the Azure/Entra steps; writes handoff.json
docs/teams-and-human-decisions.md   Proactive messaging, card design, routing, audit
docs/building-new-workflows.md      Step-by-step to create the next workflow from this one
docs/workflows/lease-review.md      The Land team lease review: what it captures, tools, routing, adaptation
```

## Build and test

Requires the .NET 10 SDK.

```bash
cd reference/headless-agent-workflow
dotnet build
dotnet test
```

The tests use a scripted model client and a file-based checkpoint store, so they run offline.

## Run locally

1. Have an administrator provision the identities and resources using [docs/azure-admin-request.md](docs/azure-admin-request.md)
   (or run `infra/provision.sh`). You get back a `handoff.json`; [docs/authentication.md](docs/authentication.md)
   explains what each value does. Sign in with `az login` using an account that was granted access in step E.
2. Fill the `{{placeholders}}` in `src/AgentWorkflow.Host/appsettings.Development.json` and
   `src/SampleMcpServer/appsettings.json`. Put the bot client secret in user secrets:
   `dotnet user-secrets set "Connections:ServiceConnection:Settings:ClientSecret" "<secret>"` (in the Host folder).
3. Start the MCP server: `dotnet run --project src/SampleMcpServer --urls https://localhost:7071`.
4. Start the host: `dotnet run --project src/AgentWorkflow.Host` and expose it with a dev tunnel; set the tunnel
   URL + `/api/messages` as the Azure Bot messaging endpoint. Install the Teams app from `src/AgentWorkflow.Host/teams-app`.
5. Kick off a run (no auth required in Development):

   ```bash
   curl -X POST http://localhost:5000/api/workflows/LeaseReview/run \
     -H 'content-type: application/json' \
     -d '{"caseId":"L-2026-0142","caseType":"LeaseReview","description":"Draft lease from Keystone Land Services for pre-execution review.","requestedBy":"land-system","attributes":{"state":"PA","county":"Washington","tractId":"T-3391","documentId":"DOC-88213"}}'
   ```

   The landman routed in `Approvals` receives the lease sign-off card in Teams. Approve it; the operator agent
   records the review, opens curative tasks through the MCP server, and a result card follows. The purchasing
   template runs the same way at `/api/workflows/HumanDecision/run` with the PO-1001 case.

`GET /api/workflows` lists the registered workflows, `GET /api/workflows/pending` lists runs waiting on a human, and
`POST /api/workflows/decisions/{requestId}/decide` records a decision without Teams (operators, tests).

## What has and has not been verified

- Compiles against the pinned package versions and passes its tests, including a real checkpoint written to disk
  by one runner and rehydrated by a second runner with a fresh workflow instance.
- The host starts with placeholder configuration; all dependency injection resolves and the trigger endpoint
  reaches the point of acquiring an Entra token.
- Not exercised here: a live Entra tenant, Azure Bot Service, Teams client rendering, or a model call. Those
  paths follow the current Microsoft samples line for line, but run them in your tenant before relying on them.
