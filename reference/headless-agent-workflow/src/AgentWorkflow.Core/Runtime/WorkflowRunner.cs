using AgentWorkflow.Core.Models;
using AgentWorkflow.Core.Workflow;
using Microsoft.Agents.AI.Workflows;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace AgentWorkflow.Core.Runtime;

public enum RunStatusKind
{
    /// <summary>The run halted at the human-decision port; a checkpoint and a pending record were saved.</summary>
    WaitingForHuman,
    Completed,
    Failed,
    /// <summary>The run ended without yielding output (should not happen with the reference graph).</summary>
    EndedWithoutOutput,
}

public sealed record WorkflowRunOutcome(
    RunStatusKind Status,
    string SessionId,
    PendingDecision? Pending = null,
    WorkflowResult? Result = null,
    string? Error = null);

/// <summary>Starts and resumes runs of one workflow type. Implemented by <see cref="WorkflowRunner"/>; fake it in tests.</summary>
public interface IWorkflowRunner
{
    string WorkflowName { get; }
    Task<WorkflowRunOutcome> StartAsync(WorkflowTrigger trigger, CancellationToken cancellationToken = default);
    Task<WorkflowRunOutcome> ResumeAsync(string requestId, Decision decision, CancellationToken cancellationToken = default);
}

/// <summary>
/// Drives Agent Framework runs as a headless turn loop:
/// <list type="number">
/// <item><see cref="StartAsync"/> runs until the graph halts on a <c>RequestPort</c>, then records the
/// checkpoint plus request id and notifies the decision channel. The process keeps nothing in memory.</item>
/// <item><see cref="ResumeAsync"/> rehydrates the run from that checkpoint (possibly in another process or
/// days later), answers the re-emitted request with the human's decision, and runs to completion or the
/// next halt.</item>
/// </list>
/// </summary>
public sealed class WorkflowRunner : IWorkflowRunner
{
    private readonly IWorkflowFactory _workflowFactory;
    private readonly CheckpointManager _checkpointManager;
    private readonly IPendingDecisionStore _pendingStore;
    private readonly IDecisionChannel _channel;
    private readonly ILogger<WorkflowRunner> _logger;

    public WorkflowRunner(
        IWorkflowFactory workflowFactory,
        CheckpointManager checkpointManager,
        IPendingDecisionStore pendingStore,
        IDecisionChannel channel,
        ILogger<WorkflowRunner>? logger = null)
    {
        _workflowFactory = workflowFactory;
        _checkpointManager = checkpointManager;
        _pendingStore = pendingStore;
        _channel = channel;
        _logger = logger ?? NullLogger<WorkflowRunner>.Instance;
    }

    /// <summary>Name of the workflow this runner starts and resumes.</summary>
    public string WorkflowName => _workflowFactory.Name;

    public async Task<WorkflowRunOutcome> StartAsync(WorkflowTrigger trigger, CancellationToken cancellationToken = default)
    {
        Microsoft.Agents.AI.Workflows.Workflow workflow = await _workflowFactory.CreateAsync(cancellationToken).ConfigureAwait(false);

        await using StreamingRun run = await InProcessExecution
            .RunStreamingAsync(workflow, trigger, _checkpointManager, sessionId: null, cancellationToken)
            .ConfigureAwait(false);

        _logger.LogInformation("Workflow {Workflow} started for case {CaseId} (session {SessionId}).", WorkflowName, trigger.CaseId, run.SessionId);
        return await RunToHaltAsync(run, previous: null, cancellationToken).ConfigureAwait(false);
    }

    public async Task<WorkflowRunOutcome> ResumeAsync(string requestId, Decision decision, CancellationToken cancellationToken = default)
    {
        PendingDecision pending = await _pendingStore.GetAsync(requestId, cancellationToken).ConfigureAwait(false)
            ?? throw new KeyNotFoundException($"No pending decision with request id '{requestId}'.");

        Microsoft.Agents.AI.Workflows.Workflow workflow = await _workflowFactory.CreateAsync(cancellationToken).ConfigureAwait(false);
        var checkpoint = new CheckpointInfo(pending.SessionId, pending.CheckpointId);

        await using StreamingRun run = await InProcessExecution
            .ResumeStreamingAsync(workflow, checkpoint, _checkpointManager, cancellationToken)
            .ConfigureAwait(false);

        // Phase 1: rehydration re-emits the request that was pending when the checkpoint was taken.
        ExternalRequest? request = null;
        await foreach (WorkflowEvent evt in run.WatchStreamAsync(blockOnPendingRequest: false, cancellationToken).ConfigureAwait(false))
        {
            if (evt is RequestInfoEvent info && info.Request.RequestId == pending.RequestId)
            {
                request = info.Request;
            }
        }

        if (request is null)
        {
            throw new InvalidOperationException(
                $"Checkpoint {pending.CheckpointId} did not re-emit request {pending.RequestId}. The workflow graph may have changed since the run was started.");
        }

        // Phase 2: answer the port and let the graph continue.
        await run.SendResponseAsync(request.CreateResponse(decision)).ConfigureAwait(false);
        await _pendingStore.RemoveAsync(requestId, cancellationToken).ConfigureAwait(false);

        _logger.LogInformation("Decision {Outcome} by {DecidedBy} applied to case {CaseId} (session {SessionId}).", decision.Outcome, decision.DecidedBy, pending.Request.CaseId, run.SessionId);
        return await RunToHaltAsync(run, pending, cancellationToken).ConfigureAwait(false);
    }

    private async Task<WorkflowRunOutcome> RunToHaltAsync(StreamingRun run, PendingDecision? previous, CancellationToken cancellationToken)
    {
        ExternalRequest? unanswered = null;
        WorkflowResult? result = null;
        string? error = null;

        // blockOnPendingRequest:false ends the stream when the graph halts on a RequestPort instead of
        // waiting in-process for the answer. That is the whole point of a headless host.
        await foreach (WorkflowEvent evt in run.WatchStreamAsync(blockOnPendingRequest: false, cancellationToken).ConfigureAwait(false))
        {
            switch (evt)
            {
                case RequestInfoEvent info:
                    unanswered = info.Request;
                    break;

                case WorkflowOutputEvent output when output.Data is WorkflowResult r:
                    result = r;
                    break;

                case WorkflowErrorEvent err:
                    error = err.Exception?.ToString() ?? "Unknown workflow error.";
                    break;

                case ExecutorFailedEvent failed:
                    error = $"Executor '{failed.ExecutorId}' failed: {failed.Data}";
                    break;
            }
        }

        if (error is not null)
        {
            _logger.LogError("Workflow session {SessionId} failed: {Error}", run.SessionId, error);
            if (previous is not null)
            {
                await _channel.FailAsync(previous, error, cancellationToken).ConfigureAwait(false);
            }

            return new WorkflowRunOutcome(RunStatusKind.Failed, run.SessionId, Error: error);
        }

        if (unanswered is not null)
        {
            return await ParkForHumanAsync(run, unanswered, cancellationToken).ConfigureAwait(false);
        }

        if (result is not null)
        {
            _logger.LogInformation("Workflow session {SessionId} completed for case {CaseId}: {Summary}", run.SessionId, result.CaseId, result.Summary);
            if (previous is not null)
            {
                await _channel.CompleteAsync(previous, result, cancellationToken).ConfigureAwait(false);
            }

            return new WorkflowRunOutcome(RunStatusKind.Completed, run.SessionId, Result: result);
        }

        return new WorkflowRunOutcome(RunStatusKind.EndedWithoutOutput, run.SessionId);
    }

    private async Task<WorkflowRunOutcome> ParkForHumanAsync(StreamingRun run, ExternalRequest request, CancellationToken cancellationToken)
    {
        if (!request.TryGetDataAs<DecisionRequest>(out DecisionRequest? decisionRequest))
        {
            throw new InvalidOperationException($"Request port '{request.PortInfo.PortId}' emitted {request.PortInfo.RequestType}, expected {nameof(DecisionRequest)}.");
        }

        // The checkpoint taken at the end of the superstep that emitted the request contains the pending request.
        CheckpointInfo checkpoint = run.LastCheckpoint
            ?? await _checkpointManager.GetLatestCheckpointAsync(run.SessionId, cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidOperationException("Workflow halted for a human decision but no checkpoint was recorded. Was a CheckpointManager supplied?");

        var pending = new PendingDecision(
            request.RequestId,
            WorkflowName,
            run.SessionId,
            checkpoint.CheckpointId,
            request.PortInfo.PortId,
            decisionRequest,
            DateTimeOffset.UtcNow,
            ChannelReference: null);

        // Save first so a notification failure can be retried without losing the run.
        await _pendingStore.SaveAsync(pending, cancellationToken).ConfigureAwait(false);

        string? channelReference = await _channel.NotifyAsync(pending, cancellationToken).ConfigureAwait(false);
        pending = pending with { ChannelReference = channelReference };
        await _pendingStore.SaveAsync(pending, cancellationToken).ConfigureAwait(false);

        _logger.LogInformation("Workflow session {SessionId} is waiting for a human decision on case {CaseId} (request {RequestId}).", run.SessionId, decisionRequest.CaseId, request.RequestId);
        return new WorkflowRunOutcome(RunStatusKind.WaitingForHuman, run.SessionId, Pending: pending);
    }
}
