using AgentWorkflow.Core.Models;
using AgentWorkflow.Core.Runtime;

namespace AgentWorkflow.Host.Triggers;

/// <summary>
/// Headless entry points. Callers are systems (Logic Apps, Functions, an ERP webhook relay, a scheduler),
/// authenticated with an Entra token for this agent's app id - the same validation the Teams endpoint uses.
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

        group.MapPost("/human-decision/run", async (WorkflowTrigger trigger, WorkflowRunner runner, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(trigger.CaseId) || string.IsNullOrWhiteSpace(trigger.CaseType))
            {
                return Results.BadRequest(new { error = "caseId and caseType are required." });
            }

            WorkflowRunOutcome outcome = await runner.StartAsync(trigger, ct);
            return Results.Ok(new
            {
                outcome.SessionId,
                status = outcome.Status.ToString(),
                requestId = outcome.Pending?.RequestId,
                result = outcome.Result,
                error = outcome.Error,
            });
        });

        group.MapGet("/human-decision/pending", async (IPendingDecisionStore store, CancellationToken ct) =>
            Results.Ok(await store.ListAsync(ct)));

        // Escape hatch for operators when Teams is unavailable, or for automated tests.
        group.MapPost("/human-decision/{requestId}/decide", async (string requestId, DecideRequest body, WorkflowRunner runner, IPendingDecisionStore store, CancellationToken ct) =>
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
            WorkflowRunOutcome outcome = await runner.ResumeAsync(requestId, decision, ct);
            return Results.Ok(new { outcome.SessionId, status = outcome.Status.ToString(), result = outcome.Result, error = outcome.Error });
        });

        return app;
    }

    public sealed record DecideRequest(DecisionOutcome Outcome, string DecidedBy, string? Comments);
}
