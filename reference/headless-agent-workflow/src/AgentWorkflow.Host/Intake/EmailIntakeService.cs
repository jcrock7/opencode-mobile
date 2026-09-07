using AgentWorkflow.Core.Intake;
using Microsoft.Extensions.Options;

namespace AgentWorkflow.Host.Intake;

/// <summary>
/// Polls the intake mailbox on an interval and runs one intake pass. This is the headless trigger for the
/// Land team's lease review when brokers submit by email. Disabled unless <c>Intake:Email:Enabled</c> is true.
/// </summary>
public sealed class EmailIntakeService(
    IOptions<EmailIntakeOptions> options,
    EmailIntakeProcessor processor,
    ILogger<EmailIntakeService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        EmailIntakeOptions o = options.Value;
        if (!o.Enabled)
        {
            logger.LogInformation("Email intake is disabled (Intake:Email:Enabled=false).");
            return;
        }

        logger.LogInformation("Email intake started in {Mode} mode, polling every {Seconds}s, starting workflow {Workflow}.", o.Mode, o.PollIntervalSeconds, o.WorkflowName);
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(Math.Max(5, o.PollIntervalSeconds)));
        do
        {
            try
            {
                IntakeRunSummary summary = await processor.RunOnceAsync(stoppingToken);
                if (summary.Seen > 0)
                {
                    logger.LogInformation("Intake pass: {Seen} seen, {Started} started, {Rejected} rejected, {Skipped} skipped, {Failed} failed.",
                        summary.Seen, summary.Started, summary.Rejected, summary.Skipped, summary.Failed);
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogError(ex, "Intake pass failed; will retry on the next interval.");
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
