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

/// <summary>
/// Where scheduled runs get their work. The sample reads static cases from configuration;
/// a real implementation polls the system of record (ERP view, queue, database) for new cases.
/// </summary>
public interface IWorkflowTriggerSource
{
    Task<IReadOnlyList<WorkflowTrigger>> GetPendingAsync(CancellationToken cancellationToken);
}

public sealed class ConfigurationTriggerSource(IConfiguration configuration) : IWorkflowTriggerSource
{
    public Task<IReadOnlyList<WorkflowTrigger>> GetPendingAsync(CancellationToken cancellationToken)
    {
        var triggers = configuration.GetSection("Triggers:Schedule:Cases").Get<List<WorkflowTrigger>>() ?? [];
        return Task.FromResult<IReadOnlyList<WorkflowTrigger>>(triggers);
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
    WorkflowRunner runner,
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
                foreach (WorkflowTrigger trigger in await source.GetPendingAsync(stoppingToken))
                {
                    if (!_started.Add(trigger.CaseId))
                    {
                        continue; // already started in this process; a real source would mark cases as taken
                    }

                    WorkflowRunOutcome outcome = await runner.StartAsync(trigger, stoppingToken);
                    logger.LogInformation("Scheduled run for case {CaseId}: {Status}", trigger.CaseId, outcome.Status);
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
