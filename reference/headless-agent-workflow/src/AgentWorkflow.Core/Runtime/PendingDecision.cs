using AgentWorkflow.Core.Models;

namespace AgentWorkflow.Core.Runtime;

/// <summary>
/// Everything needed to pick a halted run back up later, possibly in another process:
/// which checkpoint to rehydrate, which request to answer, and where the human was notified.
/// </summary>
public sealed record PendingDecision(
    string RequestId,
    string WorkflowName,
    string SessionId,
    string CheckpointId,
    string PortId,
    DecisionRequest Request,
    DateTimeOffset CreatedAt,
    string? ChannelReference,
    string? ClaimedBy = null);

/// <summary>Durable index of runs waiting on a human. Back it with a database in production.</summary>
public interface IPendingDecisionStore
{
    Task SaveAsync(PendingDecision pending, CancellationToken cancellationToken = default);
    Task<PendingDecision?> GetAsync(string requestId, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<PendingDecision>> ListAsync(CancellationToken cancellationToken = default);

    /// <summary>
    /// Atomically marks the decision as taken so a double-click, or two approvers, cannot resume the
    /// same run twice. Returns false when someone already claimed it.
    /// </summary>
    Task<bool> TryClaimAsync(string requestId, string decidedBy, CancellationToken cancellationToken = default);

    Task RemoveAsync(string requestId, CancellationToken cancellationToken = default);
}
