using AgentWorkflow.Core.Intake;

namespace AgentWorkflow.Host.Intake;

/// <summary>Operator visibility into intake: what came in, and a way to run a pass on demand.</summary>
public static class IntakeEndpoints
{
    public static IEndpointRouteBuilder MapIntakeEndpoints(this IEndpointRouteBuilder app, bool requireAuth)
    {
        RouteGroupBuilder group = app.MapGroup("/api/intake");
        if (requireAuth)
        {
            group.RequireAuthorization();
        }

        group.MapGet("/leases", async (IIntakeStore store, CancellationToken ct) => Results.Ok(await store.ListRecordsAsync(ct)));
        group.MapGet("/leases/{leaseId}", async (string leaseId, IIntakeStore store, CancellationToken ct) =>
            await store.GetRecordAsync(leaseId, ct) is { } r ? Results.Ok(r) : Results.NotFound());
        group.MapPost("/email/run", async (EmailIntakeProcessor processor, CancellationToken ct) => Results.Ok(await processor.RunOnceAsync(ct)));

        return app;
    }
}
