using System.Text.Json;
using AgentWorkflow.Core.Models;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Workflows;

namespace AgentWorkflow.Core.Workflow;

/// <summary>
/// Step 1: an agent investigates the case with MCP tools and produces a structured
/// <see cref="Assessment"/>. The executor is stateless; every run creates a fresh agent session,
/// so nothing has to be captured in checkpoints beyond the messages that flow between steps.
/// </summary>
[SendsMessage(typeof(DecisionRequest))]
public sealed class AssessExecutor : Executor<WorkflowTrigger>
{
    public const string ExecutorId = "Assess";

    private readonly AIAgent _analyst;

    public AssessExecutor(AIAgent analyst) : base(ExecutorId)
    {
        _analyst = analyst;
    }

    public override async ValueTask HandleAsync(WorkflowTrigger trigger, IWorkflowContext context, CancellationToken cancellationToken = default)
    {
        string prompt =
            $"""
            Assess the following case and produce your assessment.

            Case id: {trigger.CaseId}
            Case type: {trigger.CaseType}
            Requested by: {trigger.RequestedBy ?? "system"}
            Description: {trigger.Description}
            Attributes: {JsonSerializer.Serialize(trigger.Attributes ?? [])}
            """;

        AgentResponse<Assessment> response = await _analyst
            .RunAsync<Assessment>(prompt, cancellationToken: cancellationToken)
            .ConfigureAwait(false);

        var request = new DecisionRequest(trigger.CaseId, trigger.CaseType, response.Result, DateTimeOffset.UtcNow);
        await context.SendMessageAsync(request, cancellationToken: cancellationToken).ConfigureAwait(false);
    }
}
