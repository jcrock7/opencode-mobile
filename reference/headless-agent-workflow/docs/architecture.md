# Architecture

## Components

```
+--------------------------- AgentWorkflow.Host (ASP.NET Core) ------------------------------+
|                                                                                             |
|  Triggers                      Agent Framework runtime                 Teams (Agents SDK)   |
|  POST /api/workflows/.../run   WorkflowRunner                          DecisionAgent        |
|  ScheduledTriggerService  -->  IWorkflowFactory -> Workflow graph  <-- Action.Execute       |
|                                CheckpointManager (JSON store)          Proactive messages   |
|                                IPendingDecisionStore                   TeamsDecisionChannel |
|                                McpToolSource (HttpClientTransport + Entra bearer)           |
+------------|------------------------------|------------------------------------|------------+
             |                              |                                    |
     Azure OpenAI (Entra)          Your MCP servers (Entra app roles)     Azure Bot Service -> Teams
```

Two SDKs, one process, clean split:

- **Agent Framework** never knows about Teams. It emits a `RequestInfoEvent` and later receives an
  `ExternalResponse`. `IDecisionChannel` is the seam.
- **Agents SDK** never runs a model. It delivers cards and turns a button click into a `Decision`.

## The run lifecycle

1. **Start.** `WorkflowRunner.StartAsync` builds a fresh graph from `IWorkflowFactory`, calls
   `InProcessExecution.RunStreamingAsync(workflow, trigger, checkpointManager)` and watches events with
   `blockOnPendingRequest: false`. That flag makes the stream *end* when the graph halts on the `RequestPort`
   instead of waiting in-process for an answer.
2. **Park.** The runner reads `run.LastCheckpoint` (Agent Framework writes one at the end of every superstep,
   and the checkpoint contains the pending request), stores a `PendingDecision` (request id, session id,
   checkpoint id, the `DecisionRequest` payload), then calls `IDecisionChannel.NotifyAsync`. The run object is
   disposed. Memory is free.
3. **Decide.** A human clicks Approve/Reject. `DecisionAgent` claims the pending record atomically
   (`TryClaimAsync`), queues the resume on the Agents SDK background task queue, and replaces the card at once so
   the Teams invoke completes within its timeout.
4. **Resume.** `WorkflowRunner.ResumeAsync` builds an identical graph, calls
   `InProcessExecution.ResumeStreamingAsync(workflow, checkpoint, checkpointManager)`, drains the stream once
   (the framework re-emits the pending `RequestInfoEvent`), answers it with `request.CreateResponse(decision)`,
   and drains again to completion. The `WorkflowResult` goes back through the channel.

The tests in `tests/HumanDecisionWorkflowTests.cs` run exactly this, disposing the first checkpoint store and
creating a new runner before resuming, to prove the cross-process path.

## Durability model

| State | Where | Why |
| --- | --- | --- |
| Workflow position, messages in flight, pending requests | Agent Framework checkpoint (`ICheckpointStore<JsonElement>`) | Rehydrate the run anywhere |
| Index of runs waiting on humans | `IPendingDecisionStore` | Find the checkpoint for a request id; list "pending"; claim to prevent double-apply |
| Teams conversation references | Agents SDK `IStorage` (Blob in Azure) | Post the result to the same chat later |

The reference ships file-system implementations for the first two (single instance) and `MemoryStorage`/`BlobsStorage`
for the third. For multiple host instances:

- Implement `JsonCheckpointStore` (three methods: create, retrieve, index) over Cosmos DB, SQL, or Blob. Agent
  Framework also ships a Cosmos store for .NET; check the `Microsoft.Agents.AI.Workflows.Checkpointing` namespace
  of the version you use.
- Implement `IPendingDecisionStore` over the same database with an optimistic-concurrency claim.
- Point Agents SDK `IStorage` at Blob or Cosmos.

Checkpoint storage is a trust boundary: only the host identity should read or write it.

## Checkpoint compatibility rules

A rehydrated graph must match the one that wrote the checkpoint: same executor ids, same edges, same agent
`Id`/`Name` values. That is why:

- Executors declare constant ids (`AssessExecutor.ExecutorId`).
- Agents get fixed `Id` and `Name` in `WorkflowAgents`.
- `IWorkflowFactory` rebuilds the graph for every start and resume instead of caching one instance. One factory
  per workflow type; `WorkflowRunnerRegistry` holds a runner per factory and pending decisions record which one
  owns them.
- Message types that cross the port (`DecisionRequest`, `Decision`) are plain records serialized with the options in
  `WorkflowJson`. Renaming a property while runs are parked is a breaking change; version the type or drain first.

## Why custom executors instead of "agent as executor"

Agent Framework can place an `AIAgent` directly in a graph (it wraps it in an agent executor that speaks
`ChatMessage` and turn tokens). The reference wraps agents in small executors instead because headless workflows
want **typed messages** between steps (`WorkflowTrigger` -> `DecisionRequest` -> `Decision` -> `WorkflowResult`),
structured output from the model (`RunAsync<T>`), and no conversation history to carry through checkpoints. Use
agent-as-executor for chat-shaped pipelines (writer -> reviewer) where the transcript *is* the state.

## Scaling and hosting

- **App Service / Container Apps**: run the host as-is with a shared checkpoint store. Runs are short bursts of
  compute (assess, then park; resume, then finish), so a small plan goes far.
- **Azure Functions + Durable Task extension**: register the same `Workflow` with `ConfigureDurableWorkflows`.
  You get automatic checkpointing and `run/status/respond` HTTP endpoints; keep `TeamsDecisionChannel` and have
  `DecisionAgent` call the `respond` endpoint instead of `WorkflowRunner.ResumeAsync`.
- **Triggers**: prefer an external scheduler (Functions timer, Logic Apps, Service Bus) calling the HTTP trigger with
  an Entra token over the in-process `ScheduledTriggerService`, so runs are not tied to one always-on process.

## Observability

Agent Framework, the MCP SDK, and the Agents SDK all emit OpenTelemetry. Add `AddOpenTelemetry()` with Azure
Monitor to the host and you get one trace per run: trigger -> model calls -> MCP tool calls -> Teams send, then a
second trace for the resume keyed by the same session id (log it; the runner does).
