using AgentWorkflow.Core.Models;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Workflows;

namespace AgentWorkflow.Core.Workflow;

/// <summary>
/// Step 3: runs after the human answered. On approval an operator agent performs the single
/// proposed action through MCP tools; on rejection nothing is executed. Yields the workflow output.
/// </summary>
[YieldsOutput(typeof(WorkflowResult))]
public sealed class ApplyDecisionExecutor : Executor<Decision>
{
    public const string ExecutorId = "ApplyDecision";

    private readonly AIAgent _operator;

    public ApplyDecisionExecutor(AIAgent operatorAgent) : base(ExecutorId)
    {
        _operator = operatorAgent;
    }

    public override async ValueTask HandleAsync(Decision decision, IWorkflowContext context, CancellationToken cancellationToken = default)
    {
        DecisionRequest request = decision.Request;

        if (decision.Outcome != DecisionOutcome.Approved)
        {
            await context.YieldOutputAsync(new WorkflowResult(
                request.CaseId,
                decision.Outcome,
                decision.DecidedBy,
                $"Rejected by {decision.DecidedBy}. {decision.Comments}".Trim(),
                ActionTaken: null), cancellationToken).ConfigureAwait(false);
            return;
        }

        string prompt =
            $"""
            A human ({decision.DecidedBy}) approved the following action. Carry it out now.

            Case id: {request.CaseId}
            Case type: {request.CaseType}
            Approved action: {request.Assessment.ProposedAction}
            Approver comments: {decision.Comments ?? "(none)"}
            """;

        AgentResponse<ActionReport> response = await _operator
            .RunAsync<ActionReport>(prompt, cancellationToken: cancellationToken)
            .ConfigureAwait(false);

        ActionReport report = response.Result;
        await context.YieldOutputAsync(new WorkflowResult(
            request.CaseId,
            decision.Outcome,
            decision.DecidedBy,
            report.Succeeded ? "Approved and completed." : "Approved, but the action did not complete.",
            ActionTaken: report.Summary), cancellationToken).ConfigureAwait(false);
    }
}
