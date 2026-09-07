using AgentWorkflow.Core.Models;
using AgentWorkflow.Core.Runtime;

namespace AgentWorkflow.Core.Tests.Fakes;

public sealed class RecordingDecisionChannel : IDecisionChannel
{
    public List<PendingDecision> Notified { get; } = [];
    public List<(PendingDecision Pending, WorkflowResult Result)> Completed { get; } = [];
    public List<(PendingDecision Pending, string Error)> Failed { get; } = [];

    public Task<string?> NotifyAsync(PendingDecision pending, CancellationToken cancellationToken = default)
    {
        Notified.Add(pending);
        return Task.FromResult<string?>($"conversation-{Notified.Count}");
    }

    public Task CompleteAsync(PendingDecision pending, WorkflowResult result, CancellationToken cancellationToken = default)
    {
        Completed.Add((pending, result));
        return Task.CompletedTask;
    }

    public Task FailAsync(PendingDecision pending, string error, CancellationToken cancellationToken = default)
    {
        Failed.Add((pending, error));
        return Task.CompletedTask;
    }
}
