using System.Text.Json;
using AgentWorkflow.Core.Models;
using AgentWorkflow.Core.Runtime;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Workflows;

namespace AgentWorkflow.Core.Land;

/// <summary>
/// Step 3 of the lease review, after the human decided. The land operator agent records the review in the
/// land system. On approval it also opens one curative task per item and marks the lease approved for
/// execution; on return-for-revision it only records the outcome and comments. Yields the workflow output.
/// </summary>
[YieldsOutput(typeof(WorkflowResult))]
public sealed class RecordLeaseReviewExecutor : Executor<Decision>
{
    public const string ExecutorId = "RecordLeaseReview";

    private readonly AIAgent _operator;

    public RecordLeaseReviewExecutor(AIAgent operatorAgent) : base(ExecutorId)
    {
        _operator = operatorAgent;
    }

    public override async ValueTask HandleAsync(Decision decision, IWorkflowContext context, CancellationToken cancellationToken = default)
    {
        DecisionRequest request = decision.Request;
        if (!request.TryGetDetail(out LeaseReview? review))
        {
            throw new InvalidOperationException($"Decision for {request.CaseId} does not carry a {nameof(LeaseReview)} detail payload.");
        }

        bool approved = decision.Outcome == DecisionOutcome.Approved;
        string outcome = approved ? "ApprovedForExecution" : "ReturnedForRevision";

        string prompt = approved
            ? $"""
              A human ({decision.DecidedBy}) APPROVED lease {review.LeaseId} for execution on {decision.DecidedAt:u}.
              Approver comments: {decision.Comments ?? "(none)"}

              1. Record the lease review with outcome {outcome}, this summary, and the approver's identity and comments:
                 {review.Summary}
              2. Create one curative task per item below (category, description, recommended instrument, timing):
                 {JsonSerializer.Serialize(review.CurativeItems, WorkflowJson.CheckpointOptions)}
              3. Set the lease status to ApprovedForExecution.
              Report every task id you created.
              """
            : $"""
              A human ({decision.DecidedBy}) RETURNED lease {review.LeaseId} for revision on {decision.DecidedAt:u}.
              Approver comments: {decision.Comments ?? "(none)"}

              Record the lease review with outcome {outcome}, this summary, and the approver's identity and comments:
              {review.Summary}
              Do not change the lease status and do not create curative tasks.
              """;

        AgentResponse<LeaseReviewRecordReport> response = await _operator
            .RunAsync<LeaseReviewRecordReport>(prompt, cancellationToken: cancellationToken)
            .ConfigureAwait(false);

        LeaseReviewRecordReport report = response.Result;
        string summary = (approved, report.Succeeded) switch
        {
            (true, true) => $"Approved for execution; review recorded and {report.CurativeTaskIds.Count} curative task(s) opened.",
            (true, false) => "Approved for execution, but recording did not fully complete.",
            (false, true) => "Returned for revision; review recorded.",
            (false, false) => "Returned for revision, but recording did not fully complete.",
        };

        await context.YieldOutputAsync(new WorkflowResult(
            request.CaseId,
            decision.Outcome,
            decision.DecidedBy,
            summary,
            ActionTaken: report.Summary), cancellationToken).ConfigureAwait(false);
    }
}
