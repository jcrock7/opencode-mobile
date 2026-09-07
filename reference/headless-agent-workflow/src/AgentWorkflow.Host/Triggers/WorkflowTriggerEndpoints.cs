using AgentWorkflow.Core.Models;
using AgentWorkflow.Core.Runtime;

namespace AgentWorkflow.Host.Triggers;

/// <summary>
/// Headless entry points. Callers are systems (Logic Apps, Functions, a land-system or ERP webhook relay, a
/// scheduler), authenticated with an Entra token for this agent's app id - the same validation the Teams
/// endpoint uses. The workflow is addressed by name: <c>/api/workflows/LeaseReview/run</c>.
/// </summary>
public static class WorkflowTriggerEndpoints
{
    public static IEndpointRouteBuilder MapWorkflowTriggerEndpoints(this IEndpointRouteBuilder app, bool requireAuth)
    {
        RouteGroupBuilder group = app.MapGroup("/api/workflows");
        if (requireAuth)
        {
            group.RequireAuthorization();
        }

        group.MapGet("/", (WorkflowRunnerRegistry runners) => Results.Ok(new { workflows = runners.Names }));

        group.MapPost("/{workflowName}/run", async (string workflowName, WorkflowTrigger trigger, WorkflowRunnerRegistry runners, CancellationToken ct) =>
        {
            if (!runners.TryGet(workflowName, out WorkflowRunner runner))
            {
                return Results.NotFound(new { error = $"Unknown workflow '{workflowName}'.", known = runners.Names });
            }

            if (string.IsNullOrWhiteSpace(trigger.CaseId) || string.IsNullOrWhiteSpace(trigger.CaseType))
            {
                return Results.BadRequest(new { error = "caseId and caseType are required." });
            }

            WorkflowRunOutcome outcome = await runner.StartAsync(trigger, ct);
            return Results.Ok(new
            {
                workflow = runner.WorkflowName,
                outcome.SessionId,
                status = outcome.Status.ToString(),
                requestId = outcome.Pending?.RequestId,
                result = outcome.Result,
                error = outcome.Error,
            });
        });

        group.MapGet("/pending", async (IPendingDecisionStore store, CancellationToken ct) =>
            Results.Ok(await store.ListAsync(ct)));

        // Escape hatch for operators when Teams is unavailable, or for automated tests.
        group.MapPost("/decisions/{requestId}/decide", async (string requestId, DecideRequest body, WorkflowRunnerRegistry runners, IPendingDecisionStore store, CancellationToken ct) =>
        {
            PendingDecision? pending = await store.GetAsync(requestId, ct);
            if (pending is null)
            {
                return Results.NotFound();
            }

            if (!await store.TryClaimAsync(requestId, body.DecidedBy, ct))
            {
                return Results.Conflict(new { error = "Already decided." });
            }

            var decision = new Decision(pending.Request, body.Outcome, body.DecidedBy, body.Comments, DateTimeOffset.UtcNow);
            WorkflowRunOutcome outcome = await runners.Get(pending.WorkflowName).ResumeAsync(requestId, decision, ct);
            return Results.Ok(new { outcome.SessionId, status = outcome.Status.ToString(), result = outcome.Result, error = outcome.Error });
        });

        return app;
    }

    public sealed record DecideRequest(DecisionOutcome Outcome, string DecidedBy, string? Comments);
}
