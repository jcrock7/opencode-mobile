using AgentWorkflow.Core.Intake;
using Azure.Core;
using Microsoft.Graph;
using Microsoft.Graph.Models;
using Microsoft.Graph.Users.Item.Messages.Item.Move;

namespace AgentWorkflow.Host.Intake;

/// <summary>
/// Reads the shared intake mailbox through Microsoft Graph with the workflow's own identity (application
/// permission Mail.ReadWrite, limited to this one mailbox by an Exchange Online application access policy).
/// Unread messages in the Inbox are new; dispositioned messages are moved to Inbox/Processed or Inbox/Rejected.
/// </summary>
public sealed class GraphMailboxClient : IMailboxClient
{
    private const string ProcessedFolder = "Processed";
    private const string RejectedFolder = "Rejected";

    private readonly GraphServiceClient _graph;
    private readonly string _mailbox;
    private readonly ILogger<GraphMailboxClient> _logger;
    private readonly Dictionary<string, string> _folderIds = new(StringComparer.OrdinalIgnoreCase);

    public GraphMailboxClient(TokenCredential credential, string mailboxAddress, ILogger<GraphMailboxClient> logger)
    {
        _graph = new GraphServiceClient(credential, ["https://graph.microsoft.com/.default"]);
        _mailbox = mailboxAddress;
        _logger = logger;
    }

    public async Task<IReadOnlyList<InboundMessage>> ListNewAsync(CancellationToken cancellationToken = default)
    {
        MessageCollectionResponse? page = await _graph.Users[_mailbox].MailFolders["inbox"].Messages.GetAsync(request =>
        {
            request.QueryParameters.Filter = "isRead eq false";
            request.QueryParameters.Orderby = ["receivedDateTime asc"];
            request.QueryParameters.Top = 25;
            request.QueryParameters.Select = ["id", "internetMessageId", "from", "subject", "body", "receivedDateTime", "hasAttachments"];
            // Ask Graph for the body as plain text so the parser never sees HTML.
            request.Headers.Add("Prefer", "outlook.body-content-type=\"text\"");
        }, cancellationToken).ConfigureAwait(false);

        var result = new List<InboundMessage>();
        foreach (Message message in page?.Value ?? [])
        {
            var attachments = new List<InboundAttachment>();
            if (message.HasAttachments == true)
            {
                AttachmentCollectionResponse? list = await _graph.Users[_mailbox].Messages[message.Id!].Attachments
                    .GetAsync(r => r.QueryParameters.Select = ["id", "name", "contentType", "size"], cancellationToken).ConfigureAwait(false);
                foreach (Attachment a in list?.Value ?? [])
                {
                    if (a is FileAttachment && a.Id is not null && a.Name is not null)
                    {
                        attachments.Add(new InboundAttachment(a.Id, a.Name, a.ContentType, a.Size ?? 0));
                    }
                }
            }

            result.Add(new InboundMessage(
                message.Id!,
                message.InternetMessageId ?? message.Id!,
                message.From?.EmailAddress?.Address ?? "unknown@unknown",
                message.From?.EmailAddress?.Name,
                message.Subject ?? string.Empty,
                message.Body?.Content ?? string.Empty,
                message.ReceivedDateTime ?? DateTimeOffset.UtcNow,
                attachments));
        }

        return result;
    }

    public async Task<byte[]> GetAttachmentContentAsync(string messageId, string attachmentId, CancellationToken cancellationToken = default)
    {
        Attachment? attachment = await _graph.Users[_mailbox].Messages[messageId].Attachments[attachmentId].GetAsync(cancellationToken: cancellationToken).ConfigureAwait(false);
        return attachment is FileAttachment { ContentBytes: { } bytes }
            ? bytes
            : throw new InvalidOperationException($"Attachment {attachmentId} on message {messageId} is not a downloadable file attachment.");
    }

    public async Task MarkAsync(string messageId, IntakeDisposition disposition, string reason, CancellationToken cancellationToken = default)
    {
        string folderId = await EnsureFolderAsync(disposition == IntakeDisposition.Processed ? ProcessedFolder : RejectedFolder, cancellationToken).ConfigureAwait(false);

        // Record the disposition on the message itself before moving it, so the mailbox is its own audit trail.
        await _graph.Users[_mailbox].Messages[messageId].PatchAsync(new Message
        {
            IsRead = true,
            Categories = [disposition.ToString()],
        }, cancellationToken: cancellationToken).ConfigureAwait(false);

        await _graph.Users[_mailbox].Messages[messageId].Move.PostAsync(new MovePostRequestBody { DestinationId = folderId }, cancellationToken: cancellationToken).ConfigureAwait(false);
        _logger.LogDebug("Moved message {MessageId} to {Folder}: {Reason}", messageId, disposition, reason);
    }

    private async Task<string> EnsureFolderAsync(string displayName, CancellationToken cancellationToken)
    {
        if (_folderIds.TryGetValue(displayName, out string? cached))
        {
            return cached;
        }

        MailFolderCollectionResponse? existing = await _graph.Users[_mailbox].MailFolders["inbox"].ChildFolders
            .GetAsync(r => r.QueryParameters.Filter = $"displayName eq '{displayName}'", cancellationToken).ConfigureAwait(false);

        MailFolder folder = existing?.Value?.FirstOrDefault()
            ?? await _graph.Users[_mailbox].MailFolders["inbox"].ChildFolders
                .PostAsync(new MailFolder { DisplayName = displayName }, cancellationToken: cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidOperationException($"Could not create mail folder '{displayName}' in {_mailbox}.");

        _folderIds[displayName] = folder.Id!;
        return folder.Id!;
    }
}
