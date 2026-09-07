using AgentWorkflow.Core.Models;
using AgentWorkflow.Core.Runtime;
using Microsoft.Extensions.Options;

namespace AgentWorkflow.Host.Triggers;

/// <summary>Configuration section <c>Triggers:Schedule</c>.</summary>
public sealed class ScheduleOptions
{
    public bool Enabled { get; set; }
    public int IntervalMinutes { get; set; } = 15;
}

/// <summary>A case to start, and which workflow should run it.</summary>
public sealed class ScheduledCase
{
    public required string WorkflowName { get; set; }
    public required string CaseId { get; set; }
    public required string CaseType { get; set; }
    public string Description { get; set; } = "";
    public string? RequestedBy { get; set; }
    public Dictionary<string, string>? Attributes { get; set; }

    public WorkflowTrigger ToTrigger() => new(CaseId, CaseType, Description, RequestedBy ?? "scheduler", Attributes);
}

/// <summary>
/// Where scheduled runs get their work. The sample reads static cases from configuration; a real implementation
/// polls the system of record (the land system's "pending review" queue, an ERP view, a database) for new cases.
/// </summary>
public interface IWorkflowTriggerSource
{
    Task<IReadOnlyList<ScheduledCase>> GetPendingAsync(CancellationToken cancellationToken);
}

public sealed class ConfigurationTriggerSource(IConfiguration configuration) : IWorkflowTriggerSource
{
    public Task<IReadOnlyList<ScheduledCase>> GetPendingAsync(CancellationToken cancellationToken)
    {
        var cases = configuration.GetSection("Triggers:Schedule:Cases").Get<List<ScheduledCase>>() ?? [];
        return Task.FromResult<IReadOnlyList<ScheduledCase>>(cases);
    }
}

/// <summary>
/// The "no human, no chat" trigger: wakes up on an interval, asks the source for cases, starts a run per case.
/// Disabled by default. In production prefer an Azure Function timer or Logic App calling the HTTP trigger,
/// or a queue consumer, so runs are not tied to one always-on process.
/// </summary>
public sealed class ScheduledTriggerService(
    IOptions<ScheduleOptions> options,
    IWorkflowTriggerSource source,
    WorkflowRunnerRegistry runners,
    ILogger<ScheduledTriggerService> logger) : BackgroundService
{
    private readonly HashSet<string> _started = new(StringComparer.Ordinal);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.Enabled)
        {
            logger.LogInformation("Scheduled trigger is disabled (Triggers:Schedule:Enabled=false).");
            return;
        }

        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(Math.Max(1, options.Value.IntervalMinutes)));
        do
        {
            try
            {
                foreach (ScheduledCase scheduled in await source.GetPendingAsync(stoppingToken))
                {
                    if (!_started.Add($"{scheduled.WorkflowName}:{scheduled.CaseId}"))
                    {
                        continue; // already started in this process; a real source would mark cases as taken
                    }

                    if (!runners.TryGet(scheduled.WorkflowName, out WorkflowRunner runner))
                    {
                        logger.LogWarning("Scheduled case {CaseId} names unknown workflow {Workflow}; skipped.", scheduled.CaseId, scheduled.WorkflowName);
                        continue;
                    }

                    WorkflowRunOutcome outcome = await runner.StartAsync(scheduled.ToTrigger(), stoppingToken);
                    logger.LogInformation("Scheduled {Workflow} run for case {CaseId}: {Status}", scheduled.WorkflowName, scheduled.CaseId, outcome.Status);
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogError(ex, "Scheduled trigger iteration failed.");
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
