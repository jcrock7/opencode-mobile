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

If the human decision shape is the same (approve/reject a proposed action), reuse `DecisionRequest` and `Decision`
so the card and channel code work unchanged. The `Assessment` record is deliberately generic.

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

Implement `IWorkflowFactory` (see `HumanDecisionWorkflowFactory`). Load MCP tools through `McpToolSource`, give each
agent only the tools it needs, and always create agents with fixed `Id`/`Name`. Register it in `Program.cs`.

## 5. Route the humans

Add a `Routes` entry in `Approvals` for the new `CaseType`. If the card needs different content, add a builder in
`DecisionCard` and pick it by case type in `TeamsDecisionChannel.NotifyAsync`.

## 6. Expose the trigger

Add a `MapPost` in `WorkflowTriggerEndpoints` (or a queue consumer / timer) that turns the external event into your
trigger record and calls `WorkflowRunner.StartAsync`. One `WorkflowRunner` per workflow type; register several
with keyed services if the host runs more than one workflow.

## 7. Test without Azure

Copy `HumanDecisionWorkflowTests`: script the model's JSON answers with `ScriptedChatClient`, run start, dispose the
checkpoint store, build a new runner, resume with a decision, assert the result. This catches the two mistakes that
break production resumes: unstable executor/agent ids and message types that do not round-trip through JSON.

## 8. Ship it

- Add the new MCP server's app registration and app-role assignment (docs/authentication.md, section 3).
- Add it to `Mcp:Servers` with an `AllowedTools` list.
- Put the new approver route in `Approvals`.
- Deploy; run one case end to end in a test Teams team before pointing real triggers at it.
