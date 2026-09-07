using AgentWorkflow.Core.Models;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Workflows;

namespace AgentWorkflow.Core.Land;

/// <summary>
/// Land team pre-execution lease review:
/// <code>
///   WorkflowTrigger (lease id) -> [ReviewLease (lease analyst + land MCP read tools)] -> DecisionRequest + LeaseReview detail
///                              -> [RequestPort "LeaseSignoff"]  (halts; landman decides in Teams)
///                              -> Decision -> [RecordLeaseReview (land operator + land MCP write tools)] -> WorkflowResult
/// </code>
/// Approve = approve for execution (and open curative tasks). Reject = return for revision.
/// </summary>
public static class LeaseReviewWorkflow
{
    public const string Name = "LeaseReview";
    public const string CaseType = "LeaseReview";
    public const string DecisionPortId = "LeaseSignoff";

    public static Microsoft.Agents.AI.Workflows.Workflow Build(AIAgent leaseAnalyst, AIAgent landOperator)
    {
        var review = new ReviewLeaseExecutor(leaseAnalyst);
        RequestPort<DecisionRequest, Decision> signoff = RequestPort.Create<DecisionRequest, Decision>(DecisionPortId);
        var record = new RecordLeaseReviewExecutor(landOperator);

        return new WorkflowBuilder(review)
            .WithName(Name)
            .WithDescription("Reviews a draft oil and gas lease (terms, provisions, curative title work); a landman signs off in Teams; the review is recorded and curative tasks opened.")
            .AddEdge(review, signoff)
            .AddEdge(signoff, record)
            .WithOutputFrom(record)
            .Build();
    }
}
