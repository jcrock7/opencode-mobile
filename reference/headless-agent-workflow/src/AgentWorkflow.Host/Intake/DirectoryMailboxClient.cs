using System.Text.Json;
using AgentWorkflow.Core.Intake;

namespace AgentWorkflow.Host.Intake;

/// <summary>
/// A "mailbox" on disk for development and tests. Each message is a folder under the drop directory:
/// <code>
///   drop/
///     2026-09-07-miller/
///       message.json        { "from": "jane@keystoneland.com", "fromName": "Jane Doe", "subject": "...", "body": "...", "receivedAt": "..." }
///       Miller_Lease_Draft.pdf
/// </code>
/// Processed folders move to <c>drop/processed/</c>, rejected ones to <c>drop/rejected/</c> with a reason file.
/// </summary>
public sealed class DirectoryMailboxClient(string dropDirectory) : IMailboxClient
{
    private static readonly JsonSerializerOptions s_json = new(JsonSerializerDefaults.Web);
    private readonly DirectoryInfo _root = Directory.CreateDirectory(dropDirectory);

    private sealed record MessageFile(string From, string? FromName, string Subject, string? Body, DateTimeOffset? ReceivedAt, string? InternetMessageId);

    public Task<IReadOnlyList<InboundMessage>> ListNewAsync(CancellationToken cancellationToken = default)
    {
        var list = new List<InboundMessage>();
        foreach (DirectoryInfo folder in _root.EnumerateDirectories().Where(d => d.Name is not ("processed" or "rejected")).OrderBy(d => d.CreationTimeUtc))
        {
            string messagePath = Path.Combine(folder.FullName, "message.json");
            if (!File.Exists(messagePath))
            {
                continue;
            }

            MessageFile? msg = JsonSerializer.Deserialize<MessageFile>(File.ReadAllText(messagePath), s_json);
            if (msg is null)
            {
                continue;
            }

            var attachments = folder.EnumerateFiles()
                .Where(f => !f.Name.Equals("message.json", StringComparison.OrdinalIgnoreCase))
                .Select(f => new InboundAttachment(f.Name, f.Name, null, f.Length))
                .ToList();

            list.Add(new InboundMessage(
                folder.Name,
                msg.InternetMessageId ?? $"<{folder.Name}@drop.local>",
                msg.From,
                msg.FromName,
                msg.Subject,
                msg.Body ?? string.Empty,
                msg.ReceivedAt ?? folder.CreationTimeUtc,
                attachments));
        }

        return Task.FromResult<IReadOnlyList<InboundMessage>>(list);
    }

    public Task<byte[]> GetAttachmentContentAsync(string messageId, string attachmentId, CancellationToken cancellationToken = default) =>
        File.ReadAllBytesAsync(Path.Combine(_root.FullName, messageId, attachmentId), cancellationToken);

    public Task MarkAsync(string messageId, IntakeDisposition disposition, string reason, CancellationToken cancellationToken = default)
    {
        string target = Directory.CreateDirectory(Path.Combine(_root.FullName, disposition == IntakeDisposition.Processed ? "processed" : "rejected")).FullName;
        string destination = Path.Combine(target, messageId);
        if (Directory.Exists(destination))
        {
            destination += "-" + DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        }

        Directory.Move(Path.Combine(_root.FullName, messageId), destination);
        File.WriteAllText(Path.Combine(destination, "disposition.txt"), $"{disposition}: {reason}");
        return Task.CompletedTask;
    }
}
