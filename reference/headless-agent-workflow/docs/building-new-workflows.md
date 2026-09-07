# Building the next workflow from this one

The reference is organized so a new workflow is mostly new *message types* and *executors*; the runtime, Teams
delivery, identity, and MCP plumbing stay.

## 1. Define the messages

In your own `Models` file, define plain records for each hop. Keep them JSON-friendly (strings, numbers, lists,
nested records; string enums). They are persisted in checkpoints and shown on cards.

```csharp
public sealed record InvoiceExceptionTrigger(string InvoiceId, string Reason);
public sealed record InvoiceAssessment(string Summary, string RiskLevel, string ProposedAction, IReadOnlyList<string> Evidence);
```

Always reuse `DecisionRequest` and `Decision` as the port contract so the runner, stores, Teams channel and click
handler work unchanged. `Assessment` is the generic decision surface (summary, recommendation, risk, evidence,
proposed action). Put your rich, workflow-specific result in the request's `Detail` with
`DecisionRequest.Create(caseId, caseType, assessment, detail, attributes)` and read it back with
`request.TryGetDetail<T>(out var d)`. The lease review does exactly this with `LeaseReview`
(`src/AgentWorkflow.Core/Land`), and its card renders the detail.

## 2. Write the executors

Each executor is a small class over `Executor<TInput>` that does one thing and either sends a message or yields
output. Keep them stateless; if you must keep state across supersteps override `OnCheckpointingAsync` /
`OnCheckpointRestoredAsync`.

```csharp
[SendsMessage(typeof(DecisionRequest))]
public sealed class TriageExecutor(AIAgent agent) : Executor<InvoiceExceptionTrigger>("Triage")
{
    public override async ValueTask HandleAsync(InvoiceExceptionTrigger input, IWorkflowContext ctx, CancellationToken ct = default)
    {
        AgentResponse<Assessment> r = await agent.RunAsync<Assessment>($"Triage invoice {input.InvoiceId}: {input.Reason}", cancellationToken: ct);
        await ctx.SendMessageAsync(new DecisionRequest(input.InvoiceId, "InvoiceException", r.Result, DateTimeOffset.UtcNow), cancellationToken: ct);
    }
}
```

`RunAsync<T>` gives structured output straight from the model; the schema is generated from the record.

## 3. Compose the graph

```csharp
var triage = new TriageExecutor(analyst);
var decision = RequestPort.Create<DecisionRequest, Decision>("HumanDecision");
var apply = new ApplyDecisionExecutor(operatorAgent);

var workflow = new WorkflowBuilder(triage)
    .WithName("InvoiceException")
    .AddEdge(triage, decision)
    .AddEdge(decision, apply)
    .WithOutputFrom(apply)
    .Build();
```

Patterns worth knowing:

- **Conditional routing**: `AddSwitchCaseEdgeGroup(source, [new Case(cond, target), new Default(target)])`, e.g.
  skip the human for low-risk cases and go straight to `apply`.
- **Several approvals**: `AddFanOutEdge(prepare, [budgetPort, compliancePort])` then
  `AddFanInBarrierEdge([budgetPort, compliancePort], finalize)`. Each port produces its own card; the runner already
  handles one pending request per halt, so extend `ParkForHumanAsync` to record every `RequestInfoEvent` in the
  halt, and `ResumeAsync` to answer only the matching one and park the rest again.
- **Tool approval instead of a port**: mark an MCP tool as approval-required with Agent Framework's
  `ApprovalRequiredAIFunction`; the agent halts with a `ToolApprovalRequestContent` payload instead of your record.
  Good for "let the agent decide what to do, but confirm each write".
- **Agents as executors**: for transcript-shaped pipelines, add `AIAgent` instances directly with `AddEdge(agentA, agentB)`.

## 4. Provide a factory

Implement `IWorkflowFactory` (see `LeaseReviewWorkflowFactory`): a stable `Name`, and `CreateAsync` that loads MCP
tools through `McpToolSource`, grants each agent only the tools it needs **by explicit name**, and creates agents
with fixed `Id`/`Name`. Register it with `AddSingleton<IWorkflowFactory, YourFactory>()` in `Program.cs`; the
`WorkflowRunnerRegistry` builds one `WorkflowRunner` per factory and exposes it at `/api/workflows/{Name}/run`.
Pending decisions record the workflow name, so the Teams click resumes with the right runner automatically.

## 5. Route the humans

Add `Routes` entries in `Approvals` for the new `CaseType`, optionally per trigger attribute (`Attribute`/`Value`).
If the card needs different content, add a `YourCard.BuildRequestCard(pending, detail)` and dispatch to it from
`DecisionCard.BuildRequestCard` by case type, as `LeaseReviewCard` does. Keep the same verb and `{ requestId, outcome }`
action data so `DecisionAgent` needs no change.

## 6. Expose the trigger

Nothing to add for HTTP: `POST /api/workflows/{Name}/run` already exists for every registered factory. For a
scheduled or queue trigger, implement `IWorkflowTriggerSource` returning `ScheduledCase` items with the workflow
name, or add a queue consumer that calls `WorkflowRunnerRegistry.Get(name).StartAsync`.

## 7. Test without Azure

Copy `HumanDecisionWorkflowTests`: script the model's JSON answers with `ScriptedChatClient`, run start, dispose the
checkpoint store, build a new runner, resume with a decision, assert the result. This catches the two mistakes that
break production resumes: unstable executor/agent ids and message types that do not round-trip through JSON.

## 8. Ship it

- Add the new MCP server's app registration and app-role assignment (docs/authentication.md, section 3).
- Add it to `Mcp:Servers` with an `AllowedTools` list.
- Put the new approver route in `Approvals`.
- Deploy; run one case end to end in a test Teams team before pointing real triggers at it.
