using System.Text.Json;
using AgentWorkflow.Core.Models;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Workflows;

namespace AgentWorkflow.Core.Land;

/// <summary>
/// Step 1 of the lease review: the analyst agent reads the lease, title, ownership and company standards
/// through MCP tools and returns a structured <see cref="LeaseReview"/>. The executor turns it into the
/// generic <see cref="DecisionRequest"/> (so routing, cards and stores are shared) and attaches the full
/// review as detail for the card and the record step.
/// </summary>
[SendsMessage(typeof(DecisionRequest))]
public sealed class ReviewLeaseExecutor : Executor<WorkflowTrigger>
{
    public const string ExecutorId = "ReviewLease";

    private readonly AIAgent _analyst;

    public ReviewLeaseExecutor(AIAgent analyst) : base(ExecutorId)
    {
        _analyst = analyst;
    }

    public override async ValueTask HandleAsync(WorkflowTrigger trigger, IWorkflowContext context, CancellationToken cancellationToken = default)
    {
        string prompt =
            $"""
            Review the following draft lease before execution and produce your complete lease review.

            Lease id: {trigger.CaseId}
            Requested by: {trigger.RequestedBy ?? "land-system"}
            Context: {trigger.Description}
            Attributes: {JsonSerializer.Serialize(trigger.Attributes ?? [])}

            Retrieve the lease document and metadata, the tract title records, the mineral ownership, and the
            company standard lease positions before you write anything.
            """;

        AgentResponse<LeaseReview> response = await _analyst
            .RunAsync<LeaseReview>(prompt, cancellationToken: cancellationToken)
            .ConfigureAwait(false);

        LeaseReview review = response.Result;
        DecisionRequest request = DecisionRequest.Create(
            trigger.CaseId,
            LeaseReviewWorkflow.CaseType,
            ToAssessment(review),
            review,
            trigger.Attributes);

        await context.SendMessageAsync(request, cancellationToken: cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Collapses the review into the generic decision surface shown at the top of every card.</summary>
    public static Assessment ToAssessment(LeaseReview review)
    {
        int nonStandard = review.NonStandardProvisions.Count();
        int curative = review.CurativeItems.Count;
        int blocking = review.BlockingCurative.Count();

        string risk = review.TitleStatus.Equals("Defective", StringComparison.OrdinalIgnoreCase) || blocking > 0
            ? "High"
            : curative > 0 || nonStandard > 0 ? "Medium" : "Low";

        string recommendation = review.Recommendation switch
        {
            "ApproveForExecution" => "Approve for execution",
            "ApproveWithCurative" => "Approve for execution with curative work",
            "ReturnForRevision" => "Return to the lessor / broker for revision",
            _ => review.Recommendation,
        };

        string rationale =
            $"Title status {review.TitleStatus}; {nonStandard} non-standard or missing provision(s); " +
            $"{curative} curative item(s), {blocking} required before execution.";

        string proposedAction = review.Recommendation == "ReturnForRevision"
            ? $"Record lease {review.LeaseId} as returned for revision; do not execute."
            : $"Record the review, approve lease {review.LeaseId} for execution" +
              (curative > 0 ? $", and open {curative} curative task(s)." : ".");

        return new Assessment(review.Summary, recommendation, rationale, risk, review.Evidence, proposedAction);
    }
}
