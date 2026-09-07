using AgentWorkflow.Core.Models;

namespace AgentWorkflow.Core.Runtime;

/// <summary>
/// How humans are reached. The reference host implements this with Microsoft Teams;
/// an email, ServiceNow, or web-portal implementation plugs in here without touching the workflow.
/// </summary>
public interface IDecisionChannel
{
    /// <summary>
    /// Surface a pending decision to the right person or team. Returns an opaque reference
    /// (for Teams, the stored conversation id) used later to post the outcome.
    /// </summary>
    Task<string?> NotifyAsync(PendingDecision pending, CancellationToken cancellationToken = default);

    /// <summary>Report the final result back where the decision was made.</summary>
    Task CompleteAsync(PendingDecision pending, WorkflowResult result, CancellationToken cancellationToken = default);

    /// <summary>Report that the run failed after the decision was taken.</summary>
    Task FailAsync(PendingDecision pending, string error, CancellationToken cancellationToken = default);
}
