namespace AgentWorkflow.Core.Runtime;

/// <summary>
/// One <see cref="WorkflowRunner"/> per workflow type hosted in the process, addressed by workflow name.
/// Triggers pick a runner by the name in the URL or schedule; the Teams action handler picks it from the
/// <see cref="PendingDecision.WorkflowName"/> recorded when the run halted.
/// </summary>
public sealed class WorkflowRunnerRegistry
{
    private readonly Dictionary<string, WorkflowRunner> _runners;

    public WorkflowRunnerRegistry(IEnumerable<WorkflowRunner> runners)
    {
        _runners = new Dictionary<string, WorkflowRunner>(StringComparer.OrdinalIgnoreCase);
        foreach (WorkflowRunner runner in runners)
        {
            if (!_runners.TryAdd(runner.WorkflowName, runner))
            {
                throw new InvalidOperationException($"Two workflows are registered with the name '{runner.WorkflowName}'.");
            }
        }
    }

    public IReadOnlyCollection<string> Names => _runners.Keys;

    public bool TryGet(string workflowName, out WorkflowRunner runner) => _runners.TryGetValue(workflowName, out runner!);

    public WorkflowRunner Get(string workflowName) =>
        TryGet(workflowName, out WorkflowRunner runner)
            ? runner
            : throw new KeyNotFoundException($"No workflow named '{workflowName}' is registered. Known: {string.Join(", ", Names)}.");
}
