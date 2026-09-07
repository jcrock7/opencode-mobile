using System.Text.Json;
using AgentWorkflow.Core.Models;
using AgentWorkflow.Core.Runtime;
using Microsoft.Agents.Builder;
using Microsoft.Agents.Builder.App;
using Microsoft.Agents.Builder.App.Proactive;
using Microsoft.Agents.Core.Models;
using Microsoft.Extensions.Options;

namespace AgentWorkflow.Host.Teams;

/// <summary>
/// Delivers decisions to Microsoft Teams with the Agents SDK proactive messaging API.
/// No user has to talk to the bot first: the host creates the conversation (1:1 chat or channel post)
/// from the approver's Entra object id, posts the Adaptive Card, and stores the conversation so the
/// outcome can be posted to the same place later.
/// </summary>
public sealed class TeamsDecisionChannel : IDecisionChannel
{
    private readonly IServiceProvider _services;
    private readonly ApprovalRoutingOptions _routing;
    private readonly string _agentClientId;
    private readonly ILogger<TeamsDecisionChannel> _logger;

    public TeamsDecisionChannel(
        IServiceProvider services,
        IOptions<ApprovalRoutingOptions> routing,
        IConfiguration configuration,
        ILogger<TeamsDecisionChannel> logger)
    {
        _services = services;
        _routing = routing.Value;
        _agentClientId = configuration["Connections:ServiceConnection:Settings:ClientId"]
            ?? throw new InvalidOperationException("Connections:ServiceConnection:Settings:ClientId (the agent's Entra app id) is required.");
        _logger = logger;
    }

    // Resolved lazily: the agent depends on the runner, the runner on this channel. Agents SDK registers
    // the AgentApplication as IAgent; Proactive lives on AgentApplication.
    private (AgentApplication App, IChannelAdapter Adapter) Resolve()
    {
        var app = _services.GetRequiredService<IAgent>() as AgentApplication
            ?? throw new InvalidOperationException("The registered IAgent must derive from AgentApplication to use proactive messaging.");
        var adapter = _services.GetRequiredService<IChannelAdapter>();
        return (app, adapter);
    }

    public async Task<string?> NotifyAsync(PendingDecision pending, CancellationToken cancellationToken = default)
    {
        (AgentApplication app, IChannelAdapter adapter) = Resolve();
        ApprovalRoute route = _routing.Resolve(pending.Request);

        if (string.IsNullOrWhiteSpace(route.UserObjectId))
        {
            throw new InvalidOperationException($"No approver configured for case type '{pending.Request.CaseType}'. Set Approvals:Default:UserObjectId or an Approvals:Routes entry.");
        }

        IActivity card = CardActivity(DecisionCard.BuildRequestCard(pending));

        CreateConversationOptionsBuilder options = CreateConversationOptionsBuilder
            .Create(_agentClientId, Channels.Msteams, _routing.ServiceUrl)
            .WithTenantId(_routing.TenantId)
            .WithUser(route.UserObjectId)
            .WithTopicName($"Decision: {pending.Request.CaseType} {pending.Request.CaseId}")
            .WithActivity(card)
            .WithStoreConversation(true);

        if (!string.IsNullOrWhiteSpace(route.TeamsChannelId))
        {
            options = options.WithTeamsChannelId(route.TeamsChannelId);
        }

        Conversation conversation = await app.Proactive.CreateConversationAsync(adapter, options.Build(), cancellationToken: cancellationToken);
        string conversationId = conversation.Reference.Conversation.Id;

        _logger.LogInformation("Posted decision card for case {CaseId} (request {RequestId}) to Teams conversation {ConversationId}.",
            pending.Request.CaseId, pending.RequestId, conversationId);
        return conversationId;
    }

    public Task CompleteAsync(PendingDecision pending, WorkflowResult result, CancellationToken cancellationToken = default) =>
        SendAsync(pending, CardActivity(DecisionCard.BuildResultCard(result)), cancellationToken);

    public Task FailAsync(PendingDecision pending, string error, CancellationToken cancellationToken = default) =>
        SendAsync(pending, MessageFactory.Text($"The workflow for {pending.Request.CaseId} failed after your decision. An operator has been notified. Details: {Truncate(error, 500)}"), cancellationToken);

    private async Task SendAsync(PendingDecision pending, IActivity activity, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(pending.ChannelReference))
        {
            _logger.LogWarning("No Teams conversation recorded for request {RequestId}; result not posted.", pending.RequestId);
            return;
        }

        (AgentApplication app, IChannelAdapter adapter) = Resolve();
        await app.Proactive.SendActivityAsync(adapter, pending.ChannelReference, activity, cancellationToken);
    }

    private static IActivity CardActivity(string cardJson)
    {
        var attachment = new Attachment
        {
            ContentType = ContentTypes.AdaptiveCard,
            Content = JsonSerializer.Deserialize<JsonElement>(cardJson),
        };
        return Activity.CreateMessageActivity().AddAttachment(attachment);
    }

    private static string Truncate(string value, int max) => value.Length <= max ? value : value[..max] + "...";
}
