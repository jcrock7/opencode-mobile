using AgentWorkflow.Core.Models;
using AgentWorkflow.Core.Runtime;
using AgentWorkflow.Host.Teams;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.App;
using Microsoft.Agents.Builder.App.AdaptiveCards;
using Microsoft.Agents.Builder.State;
using Microsoft.Agents.Core.Models;
using Microsoft.Agents.Hosting.AspNetCore.BackgroundQueue;

namespace AgentWorkflow.Host;

/// <summary>
/// The Teams-facing side of the host (Microsoft 365 Agents SDK <see cref="AgentApplication"/>).
/// It does not run any AI itself. Its jobs are: receive the Approve/Reject card action, claim the
/// pending decision, hand the resume to a background task, and answer the invoke within Teams' timeout.
/// </summary>
public class DecisionAgent : AgentApplication
{
    private readonly WorkflowRunnerRegistry _runners;
    private readonly IPendingDecisionStore _pending;
    private readonly IBackgroundTaskQueue _backgroundQueue;
    private readonly ILogger<DecisionAgent> _logger;

    public DecisionAgent(
        AgentApplicationOptions options,
        WorkflowRunnerRegistry runners,
        IPendingDecisionStore pending,
        IBackgroundTaskQueue backgroundQueue,
        ILogger<DecisionAgent> logger) : base(options)
    {
        _runners = runners;
        _pending = pending;
        _backgroundQueue = backgroundQueue;
        _logger = logger;

        OnConversationUpdate(ConversationUpdateEvents.MembersAdded, WelcomeAsync);
        OnMessage("pending", ListPendingAsync);
        AdaptiveCards.OnActionExecute(DecisionCard.DecisionVerb, OnDecisionAsync);
        OnActivity(ActivityTypes.Message, OnMessageAsync, rank: RouteRank.Last);
    }

    private static async Task WelcomeAsync(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
    {
        foreach (ChannelAccount member in turnContext.Activity.MembersAdded)
        {
            if (member.Id != turnContext.Activity.Recipient.Id)
            {
                await turnContext.SendActivityAsync(
                    MessageFactory.Text("I post decisions from automated workflows here. Type **pending** to list decisions waiting on you."),
                    cancellationToken);
            }
        }
    }

    private async Task ListPendingAsync(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken)
    {
        IReadOnlyList<PendingDecision> items = await _pending.ListAsync(cancellationToken);
        if (items.Count == 0)
        {
            await turnContext.SendActivityAsync("Nothing is waiting on a decision.", cancellationToken: cancellationToken);
            return;
        }

        string text = string.Join("\n\n", items.Select(p =>
            $"- **{p.WorkflowName}: {p.Request.CaseType} {p.Request.CaseId}** (risk {p.Request.Assessment.RiskLevel}, since {p.CreatedAt:yyyy-MM-dd HH:mm} UTC){(p.ClaimedBy is null ? "" : $" - being applied by {p.ClaimedBy}")}"));
        await turnContext.SendActivityAsync(MessageFactory.Text(text), cancellationToken);
    }

    private static Task OnMessageAsync(ITurnContext turnContext, ITurnState turnState, CancellationToken cancellationToken) =>
        turnContext.SendActivityAsync(
            "I only deliver decision cards and understand **pending**. Decisions are made with the buttons on each card.",
            cancellationToken: cancellationToken);

    /// <summary>
    /// Action.Execute handler. Teams expects a response within a few seconds, so the (potentially slow)
    /// workflow resume runs in the background and the card is replaced immediately.
    /// </summary>
    private async Task<AdaptiveCardInvokeResponse> OnDecisionAsync(ITurnContext turnContext, ITurnState turnState, object data, CancellationToken cancellationToken)
    {
        DecisionCard.DecisionAction action;
        try
        {
            action = DecisionCard.ParseAction(data);
        }
        catch (ArgumentException ex)
        {
            return AdaptiveCardInvokeResponseFactory.BadRequest(ex.Message);
        }

        PendingDecision? pending = await _pending.GetAsync(action.RequestId, cancellationToken);
        if (pending is null)
        {
            return AdaptiveCardInvokeResponseFactory.Message("This decision was already recorded, or the request has expired.");
        }

        // Prefer the Entra object id for the audit trail; fall back to the display name.
        ChannelAccount from = turnContext.Activity.From;
        string decidedBy = string.IsNullOrWhiteSpace(from.AadObjectId) ? from.Name ?? from.Id : $"{from.Name} ({from.AadObjectId})";

        if (!await _pending.TryClaimAsync(action.RequestId, decidedBy, cancellationToken))
        {
            return AdaptiveCardInvokeResponseFactory.Message("Someone else already decided this request.");
        }

        var decision = new Decision(pending.Request, action.Outcome, decidedBy, action.Comments, DateTimeOffset.UtcNow);
        _logger.LogInformation("Decision {Outcome} on case {CaseId} by {DecidedBy}; resuming workflow in background.",
            decision.Outcome, pending.Request.CaseId, decidedBy);

        IWorkflowRunner runner = _runners.Get(pending.WorkflowName);
        _backgroundQueue.QueueBackgroundWorkItem(async ct =>
        {
            try
            {
                await runner.ResumeAsync(action.RequestId, decision, ct);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Resuming workflow for request {RequestId} failed.", action.RequestId);
            }
        });

        return AdaptiveCardInvokeResponseFactory.AdaptiveCard(DecisionCard.BuildDecidedCard(pending.Request, decision));
    }
}
